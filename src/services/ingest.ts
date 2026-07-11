import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db/client'
import { chunks, documents } from '../db/schema'
import { chunkText } from '../lib/chunk'
import { embed } from '../lib/embeddings'

/**
 * Core ingestion: parse-already-done → chunk → embed → store. THROWS on failure
 * (so a durable queue can retry it). Idempotent + atomic: any prior chunks for the
 * document are cleared first (a retry never duplicates), and the chunk insert +
 * status flip happen in ONE transaction (a crash can't leave "ready" with missing
 * chunks, or orphan chunks under a still-"processing" row).
 */
export async function performIngest(documentId: string, knowledgeBaseId: string, text: string): Promise<void> {
  const pieces = chunkText(text)

  // Embedding is the slow, external step — do it BEFORE opening the transaction so
  // we don't hold a DB transaction open across a network round-trip.
  const vectors = pieces.length > 0 ? await embed(pieces, 'document') : []

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, documentId))
    if (pieces.length > 0) {
      await tx.insert(chunks).values(
        pieces.map((content, i) => ({
          documentId,
          knowledgeBaseId,
          content,
          embedding: vectors[i]!,
          metadata: { index: i },
        })),
      )
    }
    await tx.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId))
  })
  console.log(`[ingest] document ${documentId}: ${pieces.length} chunks ready`)
}

/** Mark a document failed (after retries are exhausted / in-process failure). */
export async function markIngestFailed(documentId: string): Promise<void> {
  await db.update(documents).set({ status: 'error' }).where(eq(documents.id, documentId))
}

/**
 * In-process fallback used when no durable queue is configured: run once,
 * fire-and-forget, and flip status to error on failure (no retry).
 */
export async function ingestText(documentId: string, knowledgeBaseId: string, text: string): Promise<void> {
  try {
    await performIngest(documentId, knowledgeBaseId, text)
  } catch (err) {
    console.error(`[ingest] document ${documentId} failed`, err)
    await markIngestFailed(documentId)
  }
}

/**
 * Recovery scan: mark documents stuck in `processing` past a cutoff as `error`.
 * A crash/restart drops in-process ingestion promises; without this those rows
 * would sit "processing" forever. Runs at boot. (A durable queue is the real
 * fix; this bounds the damage until then.)
 */
export async function recoverStuckIngestions(olderThanMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const recovered = await db
    .update(documents)
    .set({ status: 'error' })
    .where(and(eq(documents.status, 'processing'), lt(documents.createdAt, cutoff)))
    .returning({ id: documents.id })
  if (recovered.length > 0) console.log(`[ingest] recovered ${recovered.length} stuck document(s) → error`)
  return recovered.length
}
