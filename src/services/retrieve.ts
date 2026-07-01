import { eq, inArray, desc, sql, cosineDistance } from 'drizzle-orm'
import { db } from '../db/client'
import { agentKnowledgeBases, chunks, documents, knowledgeBases } from '../db/schema'
import { env } from '../env'

export type RetrievedChunk = {
  id: string
  content: string
  documentId: string
  documentName: string
  knowledgeBaseId: string
  kbName: string
  similarity: number
}

/** The set of KB ids an agent can read = its private KB + every linked shared KB. */
export async function resolveAgentKbIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ kbId: agentKnowledgeBases.knowledgeBaseId })
    .from(agentKnowledgeBases)
    .where(eq(agentKnowledgeBases.agentId, agentId))
  return rows.map((r) => r.kbId)
}

/**
 * Top-k chunks by cosine similarity, restricted to the agent's KB set. Joins
 * document + KB names so callers can build citations showing the source.
 */
export async function searchChunks(
  agentId: string,
  queryEmbedding: number[],
  k = 6,
): Promise<RetrievedChunk[]> {
  const kbIds = await resolveAgentKbIds(agentId)
  if (kbIds.length === 0) return []

  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, queryEmbedding)})`

  const rows = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      documentId: chunks.documentId,
      documentName: documents.name,
      knowledgeBaseId: chunks.knowledgeBaseId,
      kbName: knowledgeBases.name,
      similarity,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, chunks.knowledgeBaseId))
    .where(inArray(chunks.knowledgeBaseId, kbIds))
    .orderBy(desc(similarity))
    .limit(k)

  // Post-filter: drop weakly-relevant chunks (reduces cost + prompt-injection
  // surface), then pack under a character budget so the prompt can't grow
  // unbounded. Threshold defaults off (0) so retrieval never regresses until tuned.
  const out: RetrievedChunk[] = []
  let budget = env.RETRIEVAL_CHAR_BUDGET
  for (const r of rows) {
    if (r.similarity < env.RETRIEVAL_MIN_SIMILARITY) continue
    if (out.length > 0 && r.content.length > budget) continue // always keep the top hit
    out.push(r)
    budget -= r.content.length
    if (budget <= 0) break
  }
  return out
}
