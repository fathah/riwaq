import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import type { AppEnv } from '../types'

// Resolves the request's API key to an org and pins `orgId` on the context.
// Every protected route runs through this, so handlers can trust c.get('orgId')
// and scope all queries to it — that's what keeps tenants isolated.
export const orgAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization')
  const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : c.req.header('x-api-key')

  if (!key) {
    return c.json({ error: 'missing API key (use Authorization: Bearer <key>)' }, 401)
  }

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.apiKey, key))
    .limit(1)

  if (!org) return c.json({ error: 'invalid API key' }, 401)

  c.set('orgId', org.id)
  await next()
})
