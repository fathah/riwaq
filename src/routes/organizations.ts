import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const organizationsRoute = new Hono<AppEnv>()

const createSchema = z.object({ name: z.string().min(1) })

// PUBLIC: bootstrap an org. Returns the API key ONCE — store it; it's the only
// way to authenticate every subsequent request for this tenant.
organizationsRoute.post('/organizations', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const apiKey = 'riwaq_' + randomBytes(24).toString('hex')
  const [org] = await db
    .insert(organizations)
    .values({ name: parsed.data.name, apiKey })
    .returning({ id: organizations.id, name: organizations.name, createdAt: organizations.createdAt })

  return c.json({ ...org!, apiKey }, 201)
})

// AUTHED: who am I? (Does not echo the API key.)
organizationsRoute.get('/organizations/me', orgAuth, async (c) => {
  const orgId = c.get('orgId')
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return c.json(org!)
})
