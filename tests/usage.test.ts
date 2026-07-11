import { afterAll, describe, expect, it } from 'vitest'
import { db, sql } from '../src/db/client'
import { organizations, organizationUsage } from '../src/db/schema'
import { assertChatQuota, recordChatUsage, QuotaExceededError } from '../src/services/usage'
import { env } from '../src/env'
import { eq } from 'drizzle-orm'

afterAll(async () => { await sql.end({ timeout: 1 }) })

describe('persistent organization usage governance', () => {
  it('records token and estimated-cost usage atomically', async () => {
    const [org] = await db.insert(organizations).values({ name: 'usage-test', apiKeyHash: `usage-${Date.now()}` }).returning({ id: organizations.id })
    await recordChatUsage(org!.id, 120, 30)
    await recordChatUsage(org!.id, 80, 20)
    const [usage] = await db.select().from(organizationUsage).where(eq(organizationUsage.orgId, org!.id))
    expect(usage?.chatRequests).toBe(2)
    expect(usage?.inputTokens).toBe(200)
    expect(usage?.outputTokens).toBe(50)
  })

  it('rejects an organization at its configured token ceiling', async () => {
    const [org] = await db.insert(organizations).values({ name: 'quota-test', apiKeyHash: `quota-${Date.now()}` }).returning({ id: organizations.id })
    await db.insert(organizationUsage).values({ orgId: org!.id, inputTokens: env.ORG_MAX_TOTAL_TOKENS })
    await expect(assertChatQuota(org!.id)).rejects.toBeInstanceOf(QuotaExceededError)
  })
})
