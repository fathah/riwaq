import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import { hashApiKey } from '../lib/api-key'
import { cacheGet, cacheSet } from '../lib/cache'
import { checkRateLimit } from '../lib/rate-limit'
import { env } from '../env'
import type { AppEnv } from '../types'
import { hasValidAdminToken } from '../lib/admin-auth'

const inFlightByOrg = new Map<string, number>()

// Resolves the request's API key to an org and pins `orgId` on the context, then
// applies a per-org rate limit. Every protected route runs through this, so
// handlers can trust c.get('orgId') and every tenant is rate-limited by default.
export const orgAuth = createMiddleware<AppEnv>(async (c, next) => {
  const selectedOrgId = c.req.header('x-riwaq-organization-id')?.trim()
  const header = c.req.header('authorization')
  const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : c.req.header('x-api-key')
  let orgId: string | undefined
  let adminScoped = false

  if (selectedOrgId) {
    if (!hasValidAdminToken(c)) return c.json({ error: 'valid admin token required for organization selection' }, 401)
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, selectedOrgId)).limit(1)
    if (!org) return c.json({ error: 'organization not found' }, 404)
    orgId = org.id
    adminScoped = true
  } else if (!key) {
    return c.json({ error: 'missing API key (use Authorization: Bearer <key>)' }, 401)
  } else {
    // Resolve org by API-key hash. Cache the hash→orgId mapping in DragonflyDB so the
    // hot auth path skips a DB round-trip (short TTL bounds staleness of any revocation).
    const hash = hashApiKey(key)
    const cacheKey = `auth:${hash}`
    orgId = (await cacheGet<string>(cacheKey)) ?? undefined
    if (!orgId) {
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.apiKeyHash, hash))
        .limit(1)
      if (!org) return c.json({ error: 'invalid API key' }, 401)
      orgId = org.id
      await cacheSet(cacheKey, orgId)
    }
  }

  // Per-org fixed-window rate limit.
  const rl = await checkRateLimit(`org:${orgId}`, env.RATE_LIMIT_PER_ORG, env.RATE_LIMIT_WINDOW_SECONDS)
  c.header('X-RateLimit-Limit', String(env.RATE_LIMIT_PER_ORG))
  c.header('X-RateLimit-Remaining', String(rl.remaining))
  if (!rl.allowed) {
    c.header('Retry-After', String(rl.retryAfter))
    return c.json({ error: 'rate limit exceeded' }, 429)
  }

  const inFlight = inFlightByOrg.get(orgId) ?? 0
  if (inFlight >= env.MAX_CONCURRENT_REQUESTS_PER_ORG) {
    c.header('Retry-After', '1')
    return c.json({ error: 'organization concurrency limit exceeded' }, 429)
  }

  c.set('orgId', orgId)
  c.set('adminScoped', adminScoped)
  inFlightByOrg.set(orgId, inFlight + 1)
  try {
    await next()
  } finally {
    const remaining = (inFlightByOrg.get(orgId) ?? 1) - 1
    if (remaining <= 0) inFlightByOrg.delete(orgId)
    else inFlightByOrg.set(orgId, remaining)
  }
})
