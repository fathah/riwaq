import { inArray, eq, sql, cosineDistance } from 'drizzle-orm'
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

  // CRITICAL: order by the raw cosine DISTANCE ascending (`embedding <=> query`).
  // Only this exact shape lets the planner use the HNSW index. Ordering by
  // `1 - distance DESC` (arithmetic-wrapped, reversed) forces a full scan + sort —
  // fine on a toy table, catastrophic once a tenant's KB set holds real volume.
  // Similarity is derived in the projection for display/thresholding only.
  const distance = cosineDistance(chunks.embedding, queryEmbedding)
  const similarity = sql<number>`1 - (${distance})`

  const rows = await db.transaction(async (tx) => {
    // Raise the ANN candidate list so the per-KB filter doesn't starve recall
    // (the classic filtered-HNSW cliff). SET LOCAL is scoped to this transaction.
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${env.RETRIEVAL_HNSW_EF_SEARCH}`))
    return tx
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
      .orderBy(distance)
      .limit(k)
  })

  // Post-filter: drop weakly-relevant chunks below RETRIEVAL_MIN_SIMILARITY
  // (reduces cost, prompt-injection surface, and fabricated citations), then pack
  // under a character budget so the prompt can't grow unbounded. The total injected
  // content never exceeds the budget — even a single oversized top hit is truncated
  // rather than blowing past it.
  const out: RetrievedChunk[] = []
  let budget = env.RETRIEVAL_CHAR_BUDGET
  for (const r of rows) {
    if (r.similarity < env.RETRIEVAL_MIN_SIMILARITY) continue
    if (budget <= 0) break
    const content = r.content.length > budget ? r.content.slice(0, budget) : r.content
    out.push({ ...r, content })
    budget -= content.length
  }
  return out
}
