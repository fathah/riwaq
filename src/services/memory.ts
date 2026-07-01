import { and, eq, desc, isNull, or, sql, cosineDistance } from 'drizzle-orm'
import { db } from '../db/client'
import { memories } from '../db/schema'
import { embed } from '../lib/embeddings'
import { complete, type LlmConfig } from '../lib/llm'
import { MEMORY_EXTRACT_SYSTEM, memoryExtractUser } from '../prompts/memory-extract'

const RECALL_K = 5
const DEDUP_SIMILARITY = 0.92 // near-identical facts are merged, not duplicated

/**
 * Top long-term memories to inject for THIS end user of an agent: facts learned
 * from this same user, plus agent-wide facts (endUserId IS NULL). Facts about a
 * different end user are never recalled — that would leak one user's data into
 * another user's prompt. Scoping is by (agentId, endUserId), not agentId alone.
 */
export async function recallMemories(
  agentId: string,
  endUserId: string,
  queryEmbedding: number[],
  k = RECALL_K,
): Promise<string[]> {
  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, queryEmbedding)})`
  const rows = await db
    .select({ fact: memories.fact, similarity })
    .from(memories)
    .where(and(eq(memories.agentId, agentId), or(eq(memories.endUserId, endUserId), isNull(memories.endUserId))))
    .orderBy(desc(similarity))
    .limit(k)
  return rows.map((r) => r.fact)
}

/**
 * Extract durable facts from one turn (cheap Haiku call) and upsert them.
 * Near-duplicates are skipped/refreshed so memory doesn't balloon.
 */
export async function extractAndStoreMemories(opts: {
  agentId: string
  endUserId: string
  userMessage: string
  assistantMessage: string
  llm: LlmConfig
}): Promise<void> {
  const { text } = await complete({
    config: opts.llm,
    system: MEMORY_EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: memoryExtractUser(opts.userMessage, opts.assistantMessage) }],
    maxTokens: 300,
  })

  const facts = parseFacts(text)
  if (facts.length === 0) return

  const vectors = await embed(facts, 'document')
  for (let i = 0; i < facts.length; i++) {
    await upsertMemory(opts.agentId, opts.endUserId, facts[i]!, vectors[i]!)
  }
}

async function upsertMemory(agentId: string, endUserId: string, fact: string, embedding: number[]): Promise<void> {
  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`
  // Deduplicate only against THIS user's own facts. Scoping by agent alone would
  // let one user's near-identical fact suppress (refresh instead of insert)
  // another user's — corrupting per-user memory.
  const [nearest] = await db
    .select({ id: memories.id, similarity })
    .from(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.endUserId, endUserId)))
    .orderBy(desc(similarity))
    .limit(1)

  if (nearest && nearest.similarity >= DEDUP_SIMILARITY) {
    await db.update(memories).set({ updatedAt: new Date() }).where(eq(memories.id, nearest.id))
    return
  }
  await db.insert(memories).values({ agentId, endUserId, fact, embedding })
}

function parseFacts(text: string): string[] {
  // The model is told to return a JSON array; be defensive about stray prose.
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
  } catch {
    return []
  }
}
