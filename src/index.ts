import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { env } from './env'
import { migrate } from './db/migrate'
import { sql } from './db/client'
import type { AppEnv } from './types'
import { organizationsRoute } from './routes/organizations'
import { agentsRoute } from './routes/agents'
import { knowledgeBasesRoute } from './routes/knowledge-bases'
import { documentsRoute } from './routes/documents'
import { chatRoute } from './routes/chat'
import { openaiRoute } from './routes/openai'
import { feedbackRoute } from './routes/feedback'
import { analyticsRoute } from './routes/analytics'

const app = new Hono<AppEnv>()
app.use('*', logger())

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
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[riwaq] listening on http://localhost:${info.port}`)
  })
}

main().catch((err) => {
  console.error('[riwaq] failed to start', err)
  process.exit(1)
})
