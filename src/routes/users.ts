import { Hono } from 'hono'
import { z } from 'zod'
import { pageParams } from '../lib/pagination'
import { isUuid } from '../lib/uuid'
import { orgAuth } from '../middleware/auth'
import {
  connectEndUser,
  disconnectUserIdentity,
  getEndUser,
  listEndUsers,
  listUserIdentities,
  listUserMemories,
  updateEndUser,
} from '../services/users'
import type { AppEnv } from '../types'

export const usersRoute = new Hono<AppEnv>()
usersRoute.use('*', orgAuth)

const identifier = z.string().trim().min(1).max(500)
const connectSchema = z
  .object({
    userId: identifier,
    displayName: z.string().trim().max(200).nullable().optional(),
    provider: z.string().trim().min(1).max(100).optional(),
    namespace: z.string().trim().min(1).max(200).optional(),
    externalUserId: identifier.optional(),
    mergeExisting: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.provider) === Boolean(value.externalUserId), {
    message: 'provider and externalUserId must be supplied together',
  })
const updateSchema = z.object({ displayName: z.string().trim().max(200).nullable() })

usersRoute.get('/users', async (c) => {
  const { limit, offset } = pageParams((name) => c.req.query(name))
  return c.json(await listEndUsers(c.get('orgId'), limit, offset))
})

// Idempotently create a canonical organization user and, optionally, attach an
// external platform identity in the same call. `mergeExisting` migrates durable
// user state when a platform identity was previously auto-provisioned.
usersRoute.post('/users/connect', async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  return c.json(await connectEndUser({ orgId: c.get('orgId'), ...parsed.data }))
})

usersRoute.get('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  const user = await getEndUser(c.get('orgId'), userId)
  if (!user) return c.json({ error: 'user not found' }, 404)
  return c.json({ user, identities: await listUserIdentities(c.get('orgId'), userId) })
})

usersRoute.patch('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  if (!(await updateEndUser(c.get('orgId'), userId, parsed.data.displayName))) {
    return c.json({ error: 'user not found' }, 404)
  }
  return c.json((await getEndUser(c.get('orgId'), userId))!)
})

usersRoute.get('/users/:userId/memories', async (c) => {
  const userId = c.req.param('userId')
  if (!(await getEndUser(c.get('orgId'), userId))) return c.json({ error: 'user not found' }, 404)
  const { limit, offset } = pageParams((name) => c.req.query(name))
  return c.json(await listUserMemories(c.get('orgId'), userId, limit, offset))
})

usersRoute.delete('/users/:userId/identities/:identityId', async (c) => {
  const identityId = c.req.param('identityId')
  if (!isUuid(identityId)) return c.json({ error: 'identity not found' }, 404)
  if (!(await disconnectUserIdentity(c.get('orgId'), c.req.param('userId'), identityId))) {
    return c.json({ error: 'identity not found' }, 404)
  }
  return c.json({ ok: true })
})
