import { eq, desc, sql, cosineDistance } from 'drizzle-orm'
import { db } from '../db/client'
import { topics, questionLogs } from '../db/schema'
import { complete, type LlmConfig } from '../lib/llm'
import { TOPIC_LABEL_SYSTEM } from '../prompts/memory-extract'

// If a question is at least this similar to an existing topic centroid, it joins
// that cluster; otherwise a new topic is created. Tunable.
const MATCH_THRESHOLD = 0.6

/**
 * Assign a user question to a topic cluster (nearest centroid, else new), bump
 * the count, and log it. Powers per-agent "top questions" with no manual tagging.
 */
export async function classifyQuestion(opts: {
  agentId: string
  messageId: string
  question: string
  embedding: number[]
  llm: LlmConfig
}): Promise<string> {
  const similarity = sql<number>`1 - (${cosineDistance(topics.centroid, opts.embedding)})`
  const [nearest] = await db
    .select({ id: topics.id, similarity })
    .from(topics)
    .where(eq(topics.agentId, opts.agentId))
    .orderBy(desc(similarity))
    .limit(1)

  // Label the new cluster (external LLM call) BEFORE the transaction so we don't
  // hold it open across the network.
  const label =
    nearest && nearest.similarity >= MATCH_THRESHOLD ? null : await labelQuestion(opts.question, opts.llm)

  // Assignment + log write in one transaction; the counter uses an atomic
  // `count = count + 1` (not read-then-write), so concurrent questions can't lose counts.
  return db.transaction(async (tx) => {
    let topicId: string
    if (nearest && nearest.similarity >= MATCH_THRESHOLD) {
      await tx
        .update(topics)
        .set({ count: sql`${topics.count} + 1`, lastSeen: new Date() })
        .where(eq(topics.id, nearest.id))
      topicId = nearest.id
    } else {
      const [created] = await tx
        .insert(topics)
        .values({ agentId: opts.agentId, label: label ?? 'Uncategorized', centroid: opts.embedding, count: 1 })
        .returning({ id: topics.id })
      topicId = created!.id
    }

    await tx.insert(questionLogs).values({
      agentId: opts.agentId,
      messageId: opts.messageId,
      topicId,
      embedding: opts.embedding,
    })
    return topicId
  })
}

async function labelQuestion(question: string, llm: LlmConfig): Promise<string> {
  try {
    const { text } = await complete({
      config: llm,
      system: TOPIC_LABEL_SYSTEM,
      messages: [{ role: 'user', content: question }],
      maxTokens: 20,
    })
    const label = text.trim().replace(/^["']|["']$/g, '').slice(0, 80)
    return label || 'Uncategorized'
  } catch {
    return 'Uncategorized'
  }
}
