import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { env } from './env'
import { migrate } from './db/migrate'
import { sql } from './db/client'
import { recoverStuckIngestions } from './services/ingest'
import { encryptLegacyChannelSecrets, encryptLegacyLlmSecrets } from './services/secrets'
import { startWorkers, closeQueues, queueMetrics } from './lib/queue'
import { closeRedis, redisEnabled } from './lib/redis'
import type { AppEnv } from './types'
import { organizationsRoute } from './routes/organizations'
import { agentsRoute } from './routes/agents'
import { knowledgeBasesRoute } from './routes/knowledge-bases'
import { documentsRoute } from './routes/documents'
import { chatRoute } from './routes/chat'
import { openaiRoute } from './routes/openai'
import { feedbackRoute } from './routes/feedback'
import { analyticsRoute } from './routes/analytics'
import { learningRoute } from './routes/learning'
import { remindersRoute } from './routes/reminders'
import { startReminderScheduler, stopReminderScheduler } from './services/reminders'
import { operations, operationalMetrics } from './middleware/operations'
import { getRedis } from './lib/redis'
import { openApiDocument } from './openapi'
import { ChatError } from './services/chat'
import { channelsRoute } from './routes/channels'
import { startTelegramPolling, stopTelegramPolling } from './services/telegram-polling'
import { memoriesRoute } from './routes/memories'

export const app = new Hono<AppEnv>()

// Single error boundary. Without it, any unexpected throw — a provider 4xx/5xx, a
// missing API key, a bad-UUID cast (Postgres 22P02) — returns Hono's default
// text/plain 500, breaking both the native `{error}` and the OpenAI `{error:{…}}`
// contracts. Here we map to the right status + envelope for the path.
app.onError((err, c) => {
  const status = errorStatus(err)
  const message = status >= 500 ? 'internal error' : errorMessage(err)
  if (status >= 500) console.error('[error]', c.req.method, c.req.path, err)
  if (c.req.path.startsWith('/v1/')) {
    const type = status >= 500 ? 'api_error' : 'invalid_request_error'
    return c.json({ error: { message, type, code: null } }, status as 400)
  }
  return c.json({ error: message }, status as 400)
})

app.use('*', operations)
// Reject oversized request bodies at the boundary before any handler buffers them.
app.use('*', bodyLimit({ maxSize: env.MAX_BODY_BYTES, onError: (c) => c.json({ error: 'request body too large' }, 413) }))

app.get('/', (c) => c.json({ name: 'riwaq', status: 'ok' }))
app.get('/openapi.json', (c) => c.json(openApiDocument))
app.get('/health', async (c) => {
  try {
    await sql`select 1`
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
})
app.get('/ready', async (c) => {
  try {
    await sql`select 1`
    if (redisEnabled) await getRedis()!.ping()
    return c.json({ ready: true })
  } catch {
    return c.json({ ready: false }, 503)
  }
})
app.get('/metrics', async (c) => {
  const provided = c.req.header('x-admin-token')
  if (!env.ADMIN_TOKEN || provided !== env.ADMIN_TOKEN) return c.json({ error: 'not found' }, 404)
  const queues = await queueMetrics().catch(() => ({ enabled: 0, scrape_error: 1 }))
  const queueText = Object.entries(queues).map(([name, value]) => `riwaq_queue_${name} ${value}`).join('\n')
  return c.text(`${operationalMetrics()}${queueText}\n`, 200, { 'Content-Type': 'text/plain; version=0.0.4' })
})

// Each sub-app applies org-auth internally (except the public POST /organizations).
// All are mounted at root and declare absolute paths.
app.route('/', organizationsRoute)
app.route('/', agentsRoute)
app.route('/', knowledgeBasesRoute)
app.route('/', documentsRoute)
app.route('/', chatRoute)
app.route('/', openaiRoute)
app.route('/', feedbackRoute)
app.route('/', analyticsRoute)
app.route('/', learningRoute)
app.route('/', remindersRoute)
app.route('/', channelsRoute)
app.route('/', memoriesRoute)

// Map a thrown error to an HTTP status. ChatError carries its own; provider SDK
// errors expose a numeric `status`; a Postgres UUID cast error is a client 400;
// everything else is an unexpected 500.
function errorStatus(err: unknown): number {
  if (err instanceof ChatError) return err.status
  const anyErr = err as { status?: unknown; code?: unknown }
  if (typeof anyErr?.status === 'number' && anyErr.status >= 400 && anyErr.status < 600) return anyErr.status
  if (anyErr?.code === '22P02') return 400 // invalid text representation (e.g. bad uuid)
  return 500
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'request failed'
}

async function main() {
  await migrate()
  const encryptedSecrets = await encryptLegacyLlmSecrets() + await encryptLegacyChannelSecrets()
  if (encryptedSecrets > 0) {
    console.log(`[riwaq] encrypted ${encryptedSecrets} legacy LLM credential(s)`)
  }
  // Boot recovery: fail any ingestion left "processing" by a previous crash.
  await recoverStuckIngestions().catch((err) => console.error('[riwaq] recovery scan failed', err))

  // Durable job workers (no-op unless REDIS_URL is set).
  startWorkers()
  console.log(`[riwaq] durable jobs: ${redisEnabled ? 'DragonflyDB/Redis' : 'in-process fallback'}`)

  // Telegram uses outbound long polling: no public URL, reverse proxy, or extra
  // gateway container is needed. Advisory locks make this multi-replica safe.
  await startTelegramPolling()

  // Reminder scheduler: polls due reminders and fires signed webhooks. Multi-node
  // safe (FOR UPDATE SKIP LOCKED), so every replica may run it.
  startReminderScheduler()

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[riwaq] listening on http://localhost:${info.port}`)
  })

  // Graceful shutdown: stop accepting new connections, WAIT for in-flight requests
  // to finish, then drain the DB pool. `server.close` signals completion via its
  // callback, so we await it before touching the database.
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[riwaq] ${signal} received, shutting down`)
    let forceTimer: NodeJS.Timeout | undefined
    try {
      const drained = new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
      const deadline = new Promise<never>((_, reject) => {
        forceTimer = setTimeout(
          () => reject(new Error(`HTTP drain exceeded ${env.SHUTDOWN_TIMEOUT_MS}ms`)),
          env.SHUTDOWN_TIMEOUT_MS,
        )
        forceTimer.unref()
      })
      await Promise.race([drained, deadline])
    } catch (err) {
      console.error('[riwaq] error closing HTTP server', err)
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
    } finally {
      if (forceTimer) clearTimeout(forceTimer)
    }
    // Stop inbound pollers, then workers (finish in-flight jobs), then DB/Redis.
    stopReminderScheduler()
    await stopTelegramPolling().catch((err) => console.error('[riwaq] error stopping Telegram polling', err))
    await closeQueues().catch((err) => console.error('[riwaq] error closing queues', err))
    try {
      await sql.end({ timeout: 5 })
    } catch (err) {
      console.error('[riwaq] error draining DB pool', err)
    }
    await closeRedis().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Only boot the server when run directly (tsx src/index.ts). Importing `app`
// (e.g. from tests) must not start the server or run migrations as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[riwaq] failed to start', err)
    process.exit(1)
  })
}
