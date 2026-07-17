import { Hono } from 'hono'
import { z } from 'zod'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { isUuid } from '../lib/uuid'
import { pageParams } from '../lib/pagination'
import {
  createReminder,
  listReminders,
  getReminder,
  cancelReminder,
  listDeliveries,
} from '../services/reminders'
import type { AppEnv } from '../types'
import { ensureEndUser } from '../services/users'

export const remindersRoute = new Hono<AppEnv>()
remindersRoute.use('*', orgAuth)

const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4000).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    dueAt: z.string().datetime(), // ISO 8601
    recurrence: z.enum(['daily', 'weekly', 'monthly', 'yearly']).nullable().optional(),
    endUserId: z.string().min(1).optional(),
  })
  .refine((v) => v.message || v.prompt, { message: 'provide `message` or `prompt`' })

const listStatus = z.enum(['scheduled', 'firing', 'completed', 'error', 'cancelled']).optional()

// Schedule a reminder for an agent. dueAt must be in the future.
remindersRoute.post('/agents/:id/reminders', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const dueAt = new Date(parsed.data.dueAt)
  if (dueAt.getTime() <= Date.now()) return c.json({ error: 'dueAt must be in the future' }, 400)
  if (parsed.data.endUserId) await ensureEndUser(agent.orgId, parsed.data.endUserId)

  const row = await createReminder({
    orgId: agent.orgId,
    agentId: agent.id,
    dueAt,
    title: parsed.data.title,
    ...(parsed.data.message ? { message: parsed.data.message } : {}),
    ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
    ...(parsed.data.recurrence !== undefined ? { recurrence: parsed.data.recurrence } : {}),
    ...(parsed.data.endUserId ? { endUserId: parsed.data.endUserId } : {}),
  })
  return c.json(row, 201)
})

remindersRoute.get('/agents/:id/reminders', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const status = listStatus.safeParse(c.req.query('status') || undefined)
  if (!status.success) return c.json({ error: 'invalid status' }, 400)
  const { limit, offset } = pageParams((n) => c.req.query(n))
  return c.json(await listReminders(agent.id, status.data, limit, offset))
})

remindersRoute.get('/agents/:id/reminders/:rid', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const rid = c.req.param('rid')
  if (!isUuid(rid)) return c.json({ error: 'reminder not found' }, 404)

  const row = await getReminder(agent.id, rid)
  if (!row) return c.json({ error: 'reminder not found' }, 404)
  return c.json(row)
})

remindersRoute.delete('/agents/:id/reminders/:rid', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const rid = c.req.param('rid')
  if (!isUuid(rid)) return c.json({ error: 'reminder not found' }, 404)

  const ok = await cancelReminder(agent.id, rid)
  if (!ok) return c.json({ error: 'no cancellable reminder with that id' }, 404)
  return c.json({ ok: true, status: 'cancelled' })
})

// Delivery audit trail for one reminder.
remindersRoute.get('/agents/:id/reminders/:rid/deliveries', async (c) => {
  const agent = await getAgentInOrg(c.req.param('id'), c.get('orgId'))
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const rid = c.req.param('rid')
  if (!isUuid(rid)) return c.json({ error: 'reminder not found' }, 404)
  const row = await getReminder(agent.id, rid)
  if (!row) return c.json({ error: 'reminder not found' }, 404)

  const { limit, offset } = pageParams((n) => c.req.query(n))
  return c.json(await listDeliveries(rid, limit, offset))
})
