import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { env } from './env'
import { migrate } from './db/migrate'
import { sql } from './db/client'
import { recoverStuckIngestions } from './services/ingest'
import type { AppEnv } from './types'
import { organizationsRoute } from './routes/organizations'
import { agentsRoute } from './routes/agents'
import { knowledgeBasesRoute } from './routes/knowledge-bases'
import { documentsRoute } from './routes/documents'
import { chatRoute } from './routes/chat'
import { openaiRoute } from './routes/openai'
import { feedbackRoute } from './routes/feedback'
import { analyticsRoute } from './routes/analytics'

export const app = new Hono<AppEnv>()
app.use('*', logger())
// Reject oversized request bodies at the boundary before any handler buffers them.
app.use('*', bodyLimit({ maxSize: env.MAX_BODY_BYTES, onError: (c) => c.json({ error: 'request body too large' }, 413) }))

app.get('/', (c) => c.json({ name: 'riwaq', status: 'ok' }))
app.get('/health', async (c) => {
  try {
    await sql`select 1`
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 503)
  }
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
  // Boot recovery: fail any ingestion left "processing" by a previous crash.
  await recoverStuckIngestions().catch((err) => console.error('[riwaq] recovery scan failed', err))

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[riwaq] listening on http://localhost:${info.port}`)
  })

  // Graceful shutdown: stop accepting connections, then drain the DB pool.
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[riwaq] ${signal} received, shutting down`)
    server.close()
    try {
      await sql.end({ timeout: 5 })
    } catch (err) {
      console.error('[riwaq] error draining DB pool', err)
    }
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
