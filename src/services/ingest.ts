import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { chunks, documents } from '../db/schema'
import { chunkText } from '../lib/chunk'
import { embed } from '../lib/embeddings'

/**
 * Parse-already-done → chunk → embed → store. Runs in the background after the
 * upload endpoint has returned. Flips the document's status to ready/error.
 */
export async function ingestText(documentId: string, knowledgeBaseId: string, text: string): Promise<void> {
  try {
    const pieces = chunkText(text)
    if (pieces.length === 0) {
      await db.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId))
      return
    }

    const vectors = await embed(pieces, 'document')
    const rows = pieces.map((content, i) => ({
      documentId,
      knowledgeBaseId,
      content,
      embedding: vectors[i]!,
      metadata: { index: i },
    }))

    await db.insert(chunks).values(rows)
    await db.update(documents).set({ status: 'ready' }).where(eq(documents.id, documentId))
    console.log(`[ingest] document ${documentId}: ${rows.length} chunks ready`)
  } catch (err) {
    console.error(`[ingest] document ${documentId} failed`, err)
    await db.update(documents).set({ status: 'error' }).where(eq(documents.id, documentId))
  }
}
