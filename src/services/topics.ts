import { eq, sql, cosineDistance } from 'drizzle-orm'
import { db } from '../db/client'
import { topics, questionLogs } from '../db/schema'
import { complete, type LlmConfig, type Usage } from '../lib/llm'
import { env } from '../env'
import { TOPIC_LABEL_SYSTEM } from '../prompts/memory-extract'

const MATCH_THRESHOLD = env.TOPIC_MATCH_THRESHOLD

export type ClassifyResult = { topicId: string; usage: Usage }

/**
 * Assign a user question to a topic cluster (nearest centroid, else new), bump
 * the count, and log it. Powers per-agent "top questions" with no manual tagging.
 * Returns any LLM usage spent labelling a new cluster so it can be metered.
 */
export async function classifyQuestion(opts: {
  agentId: string
  messageId: string
  question: string
  embedding: number[]
  topSimilarity?: number
  llm: LlmConfig
}): Promise<ClassifyResult> {
  const noUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  // A durable job may be delivered more than once. The message is the idempotency
  // key, so a completed classification is returned without incrementing again.
  const [done] = await db
    .select({ topicId: questionLogs.topicId })
    .from(questionLogs)
    .where(eq(questionLogs.messageId, opts.messageId))
    .limit(1)
  if (done?.topicId) return { topicId: done.topicId, usage: noUsage }

  // Order by raw cosine distance ascending so the HNSW centroid index is used.
  const distance = cosineDistance(topics.centroid, opts.embedding)
  const [nearest] = await db
    .select({ id: topics.id, similarity: sql<number>`1 - (${distance})` })
    .from(topics)
    .where(eq(topics.agentId, opts.agentId))
    .orderBy(distance)
    .limit(1)

  // Label the new cluster (external LLM call) BEFORE the transaction so we don't
  // hold it open across the network.
  const labelled =
    nearest && nearest.similarity >= MATCH_THRESHOLD ? null : await labelQuestion(opts.question, opts.llm)
  const label = labelled?.label ?? null
  const usage = labelled?.usage ?? noUsage

  // Assignment + log write in one transaction; the counter uses an atomic
  // `count = count + 1` (not read-then-write), so concurrent questions can't lose counts.
  const topicId = await db.transaction(async (tx) => {
    // Serialize topic creation for one agent. This prevents two concurrent first
    // questions from both observing an empty cluster set and creating duplicates.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${opts.agentId}))`)
    const [alreadyDone] = await tx
      .select({ topicId: questionLogs.topicId })
      .from(questionLogs)
      .where(eq(questionLogs.messageId, opts.messageId))
      .limit(1)
    if (alreadyDone?.topicId) return alreadyDone.topicId

    // Re-read after acquiring the lock; the pre-lock nearest result may have
    // become stale while another request created the first cluster. Fetch the
    // centroid + count too so a matched cluster's centroid can be moved.
    const [lockedNearest] = await tx
      .select({ id: topics.id, similarity: sql<number>`1 - (${distance})`, centroid: topics.centroid, count: topics.count })
      .from(topics)
      .where(eq(topics.agentId, opts.agentId))
      .orderBy(distance)
      .limit(1)

    let assignedTopicId: string
    if (lockedNearest && lockedNearest.similarity >= MATCH_THRESHOLD) {
      // Move the centroid toward the new member (incremental running mean):
      //   c' = c + (x - c) / (n + 1)
      // Without this the centroid stays frozen at the first question forever, so
      // "clusters" degrade into first-exemplar buckets. Cosine ignores magnitude,
      // so the un-normalized mean direction is a valid centroid.
      const n = lockedNearest.count
      const movedCentroid = lockedNearest.centroid.map((v, i) => v + ((opts.embedding[i] ?? 0) - v) / (n + 1))
      await tx
        .update(topics)
        .set({ count: sql`${topics.count} + 1`, lastSeen: new Date(), centroid: movedCentroid })
        .where(eq(topics.id, lockedNearest.id))
      assignedTopicId = lockedNearest.id
    } else {
      const [created] = await tx
        .insert(topics)
        .values({ agentId: opts.agentId, label: label ?? 'Uncategorized', centroid: opts.embedding, count: 1 })
        .returning({ id: topics.id })
      assignedTopicId = created!.id
    }

    await tx.insert(questionLogs).values({
      agentId: opts.agentId,
      messageId: opts.messageId,
      topicId: assignedTopicId,
      embedding: opts.embedding,
      topSimilarity: opts.topSimilarity ?? 0,
    })
    return assignedTopicId
  })
  return { topicId, usage }
}

async function labelQuestion(question: string, llm: LlmConfig): Promise<{ label: string; usage: Usage }> {
  try {
    const res = await complete({
      config: llm,
      system: TOPIC_LABEL_SYSTEM,
      messages: [{ role: 'user', content: question }],
      maxTokens: 20,
    })
    const label = res.text.trim().replace(/^["']|["']$/g, '').slice(0, 80)
    return { label: label || 'Uncategorized', usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens } }
  } catch {
    return { label: 'Uncategorized', usage: { inputTokens: 0, outputTokens: 0 } }
  }
}
