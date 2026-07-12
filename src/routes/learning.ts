import { Hono } from 'hono'
import { z } from 'zod'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { isUuid } from '../lib/uuid'
import { pageParams } from '../lib/pagination'
import {
  listLearnedAnswers,
  approveLearnedAnswer,
  rejectLearnedAnswer,
  getLearningReport,
} from '../services/learning'
import type { AppEnv } from '../types'

// Operator-facing self-learning surface. Authenticated with the org API key (the
// operator), so end users — who only hold end-user tokens — can never approve or
// reject learned knowledge.
export const learningRoute = new Hono<AppEnv>()
learningRoute.use('*', orgAuth)

const statusSchema = z.enum(['pending', 'approved', 'rejected']).optional()

// The learning report: knowledge gaps, answer coverage, learned-answer pipeline.
learningRoute.get('/agents/:id/analytics/learning', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  return c.json(await getLearningReport(agent.id))
})

// List learned-answer candidates (optionally filtered by status).
learningRoute.get('/agents/:id/learned-answers', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const parsedStatus = statusSchema.safeParse(c.req.query('status') || undefined)
  if (!parsedStatus.success) return c.json({ error: 'invalid status' }, 400)

  const { limit, offset } = pageParams((n) => c.req.query(n))
  return c.json(await listLearnedAnswers(agent.id, parsedStatus.data, limit, offset))
})

// Operator approves a candidate → it is promoted into the agent's knowledge base.
learningRoute.post('/agents/:id/learned-answers/:laId/approve', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const laId = c.req.param('laId')
  if (!isUuid(laId)) return c.json({ error: 'learned answer not found' }, 404)

  const result = await approveLearnedAnswer(agent.id, laId)
  if (result === 'noop') return c.json({ error: 'no pending learned answer with that id' }, 404)
  return c.json({ ok: true, status: 'approved' })
})

// Operator rejects a candidate → never re-clustered or promoted.
learningRoute.post('/agents/:id/learned-answers/:laId/reject', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const laId = c.req.param('laId')
  if (!isUuid(laId)) return c.json({ error: 'learned answer not found' }, 404)

  const ok = await rejectLearnedAnswer(agent.id, laId)
  if (!ok) return c.json({ error: 'no pending learned answer with that id' }, 404)
  return c.json({ ok: true, status: 'rejected' })
})
