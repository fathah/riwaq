import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { env } from './env'
import { migrate } from './db/migrate'
import { sql } from './db/client'
import { recoverStuckIngestions } from './services/ingest'
import { encryptLegacyLlmSecrets } from './services/secrets'
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
import { operations, operationalMetrics } from './middleware/operations'
import { getRedis } from './lib/redis'
import { openApiDocument } from './openapi'

export const app = new Hono<AppEnv>()
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

async function main() {
  await migrate()
  const encryptedSecrets = await encryptLegacyLlmSecrets()
  if (encryptedSecrets > 0) {
    console.log(`[riwaq] encrypted ${encryptedSecrets} legacy LLM credential(s)`)
  }
  // Boot recovery: fail any ingestion left "processing" by a previous crash.
  await recoverStuckIngestions().catch((err) => console.error('[riwaq] recovery scan failed', err))

  // Durable job workers (no-op unless REDIS_URL is set).
  startWorkers()
  console.log(`[riwaq] durable jobs: ${redisEnabled ? 'DragonflyDB/Redis' : 'in-process fallback'}`)

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
    // Stop workers first (finish in-flight jobs), then the DB pool and Redis.
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
