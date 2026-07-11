import { count, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { chunks, documents, knowledgeBases, organizationUsage } from '../db/schema'
import { env } from '../env'

export class QuotaExceededError extends Error {}

export async function assertChatQuota(orgId: string): Promise<void> {
  if (env.ORG_MAX_TOTAL_TOKENS === 0 && env.ORG_MAX_ESTIMATED_COST_MICROS === 0) return
  const [usage] = await db.select().from(organizationUsage).where(eq(organizationUsage.orgId, orgId)).limit(1)
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  if (env.ORG_MAX_TOTAL_TOKENS > 0 && tokens >= env.ORG_MAX_TOTAL_TOKENS)
    throw new QuotaExceededError('organization token quota exceeded')
  if (env.ORG_MAX_ESTIMATED_COST_MICROS > 0 && (usage?.estimatedCostMicros ?? 0) >= env.ORG_MAX_ESTIMATED_COST_MICROS)
    throw new QuotaExceededError('organization spend quota exceeded')
}

export async function recordChatUsage(orgId: string, inputTokens: number, outputTokens: number): Promise<void> {
  const cost = Math.ceil(
    (inputTokens * env.COST_PER_MILLION_INPUT_TOKENS_MICROS +
      outputTokens * env.COST_PER_MILLION_OUTPUT_TOKENS_MICROS) / 1_000_000,
  )
  await db
    .insert(organizationUsage)
    .values({ orgId, chatRequests: 1, inputTokens, outputTokens, estimatedCostMicros: cost })
    .onConflictDoUpdate({
      target: organizationUsage.orgId,
      set: {
        chatRequests: sql`${organizationUsage.chatRequests} + 1`,
        inputTokens: sql`${organizationUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${organizationUsage.outputTokens} + ${outputTokens}`,
        estimatedCostMicros: sql`${organizationUsage.estimatedCostMicros} + ${cost}`,
        updatedAt: new Date(),
      },
    })
}

export async function assertStorageQuota(orgId: string, incomingChars: number): Promise<void> {
  const [[docCount], [stored]] = await Promise.all([
    db.select({ value: count() }).from(documents).innerJoin(knowledgeBases, eq(documents.knowledgeBaseId, knowledgeBases.id)).where(eq(knowledgeBases.orgId, orgId)),
    db.select({ value: sql<number>`coalesce(sum(length(${chunks.content})), 0)` }).from(chunks).innerJoin(knowledgeBases, eq(chunks.knowledgeBaseId, knowledgeBases.id)).where(eq(knowledgeBases.orgId, orgId)),
  ])
  if (Number(docCount?.value ?? 0) >= env.ORG_MAX_DOCUMENTS) throw new QuotaExceededError('organization document quota exceeded')
  if (Number(stored?.value ?? 0) + incomingChars > env.ORG_MAX_STORED_CHARS)
    throw new QuotaExceededError('organization storage quota exceeded')
}

export async function getUsageSnapshot(orgId: string) {
  const [[usage], [docCount], [stored]] = await Promise.all([
    db.select().from(organizationUsage).where(eq(organizationUsage.orgId, orgId)).limit(1),
    db.select({ value: count() }).from(documents).innerJoin(knowledgeBases, eq(documents.knowledgeBaseId, knowledgeBases.id)).where(eq(knowledgeBases.orgId, orgId)),
    db.select({ value: sql<number>`coalesce(sum(length(${chunks.content})), 0)` }).from(chunks).innerJoin(knowledgeBases, eq(chunks.knowledgeBaseId, knowledgeBases.id)).where(eq(knowledgeBases.orgId, orgId)),
  ])
  return {
    usage: {
      chatRequests: usage?.chatRequests ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      estimatedCostMicros: usage?.estimatedCostMicros ?? 0,
      documents: Number(docCount?.value ?? 0),
      storedChars: Number(stored?.value ?? 0),
      updatedAt: usage?.updatedAt ?? null,
    },
    limits: {
      totalTokens: env.ORG_MAX_TOTAL_TOKENS,
      estimatedCostMicros: env.ORG_MAX_ESTIMATED_COST_MICROS,
      documents: env.ORG_MAX_DOCUMENTS,
      storedChars: env.ORG_MAX_STORED_CHARS,
    },
  }
}
