import { Hono } from 'hono'
import { z } from 'zod'
import { getAgentInOrg } from '../db/guards'
import { pageParams } from '../lib/pagination'
import { isUuid } from '../lib/uuid'
import { orgAuth } from '../middleware/auth'
import {
  createMemory,
  deleteMemory,
  forgetUserMemories,
  listMemories,
  updateMemory,
} from '../services/memory'
import type { AppEnv } from '../types'
import { ensureEndUser } from '../services/users'

export const memoriesRoute = new Hono<AppEnv>()
memoriesRoute.use('*', orgAuth)

const factSchema = z.string().trim().min(1).max(1000)
const createSchema = z.object({
  fact: factSchema,
  endUserId: z.string().trim().min(1).max(500).nullable().optional(),
})
const updateSchema = z.object({ fact: factSchema })
const forgetSchema = z.string().trim().min(1).max(500)

memoriesRoute.get('/agents/:id/memories', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const { limit, offset } = pageParams((name) => c.req.query(name))
  return c.json(await listMemories(agent.id, limit, offset))
})

memoriesRoute.post('/agents/:id/memories', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  if (parsed.data.endUserId) await ensureEndUser(agent.orgId, parsed.data.endUserId)
  const created = await createMemory({
    agentId: agent.id,
    endUserId: parsed.data.endUserId ?? null,
    fact: parsed.data.fact,
  })
  return c.json(created, 201)
})

memoriesRoute.patch('/agents/:id/memories/:memoryId', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const memoryId = c.req.param('memoryId')
  if (!isUuid(memoryId)) return c.json({ error: 'memory not found' }, 404)
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const updated = await updateMemory(agent.id, memoryId, parsed.data.fact)
  if (!updated) return c.json({ error: 'memory not found' }, 404)
  return c.json(updated)
})

memoriesRoute.delete('/agents/:id/memories/:memoryId', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const memoryId = c.req.param('memoryId')
  if (!isUuid(memoryId)) return c.json({ error: 'memory not found' }, 404)
  if (!(await deleteMemory(agent.id, memoryId))) return c.json({ error: 'memory not found' }, 404)
  return c.json({ ok: true })
})

memoriesRoute.delete('/agents/:id/memories', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const parsed = forgetSchema.safeParse(c.req.query('endUserId'))
  if (!parsed.success) return c.json({ error: 'endUserId is required' }, 400)
  return c.json({ ok: true, deleted: await forgetUserMemories(agent.id, parsed.data) })
})
