import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { topics } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import type { AppEnv } from '../types'

export const analyticsRoute = new Hono<AppEnv>()
analyticsRoute.use('*', orgAuth)

// Per-agent "most asked", straight from the auto-formed topic clusters.
analyticsRoute.get('/agents/:id/analytics/top-questions', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  // Clamp to [1,100]; a negative/NaN limit would otherwise reach `LIMIT -5` → 500.
  const requested = Number(c.req.query('limit'))
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 100) : 20
  const rows = await db
    .select({ label: topics.label, count: topics.count, lastSeen: topics.lastSeen })
    .from(topics)
    .where(eq(topics.agentId, agent.id))
    .orderBy(desc(topics.count), desc(topics.lastSeen))
    .limit(limit)

  return c.json(rows)
})
