import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { documents, knowledgeBases } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg, getKbInOrg } from '../db/guards'
import { parseToText } from '../lib/parse'
import { ingestText } from '../services/ingest'
import type { AppEnv } from '../types'

export const documentsRoute = new Hono<AppEnv>()
documentsRoute.use('*', orgAuth)

// Bound ingestion work: cap raw upload bytes and the extracted-text length so a
// single tenant can't exhaust memory or run away on embedding cost.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // 15 MB raw file
const MAX_TEXT_CHARS = 5_000_000 // ~5 MB of extracted text
const MAX_NAME_LEN = 300

class UploadTooLarge extends Error {}

function capText(text: string): string {
  if (text.length > MAX_TEXT_CHARS) throw new UploadTooLarge(`document text exceeds ${MAX_TEXT_CHARS} characters`)
  return text
}

// Create a document row, kick off async ingestion, return immediately.
async function createAndIngest(kbId: string, name: string, source: 'file' | 'text', text: string) {
  const [doc] = await db
    .insert(documents)
    .values({ knowledgeBaseId: kbId, name, source, status: 'processing' })
    .returning({ id: documents.id, status: documents.status, name: documents.name })

  // Fire-and-forget: parse/chunk/embed/store happens after we respond.
  void ingestText(doc!.id, kbId, text)
  return doc!
}

// Accepts multipart (field `file`, optional `name`) OR JSON `{ text, name }`.
async function readUpload(c: Context<AppEnv>) {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody()
    const file = body['file']
    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`file exceeds ${MAX_UPLOAD_BYTES} bytes`)
      const buf = Buffer.from(await file.arrayBuffer())
      const name = ((typeof body['name'] === 'string' && body['name']) || file.name || 'upload').slice(0, MAX_NAME_LEN)
      const text = capText(await parseToText(file.name || name, file.type, buf))
      return { name, source: 'file' as const, text }
    }
    if (typeof body['text'] === 'string') {
      const name = ((typeof body['name'] === 'string' && body['name']) || 'text').slice(0, MAX_NAME_LEN)
      return { name, source: 'text' as const, text: capText(body['text']) }
    }
    return null
  }

  // JSON body
  const json = (await c.req.json().catch(() => null)) as { text?: string; name?: string } | null
  if (json && typeof json.text === 'string') {
    return { name: (json.name || 'text').slice(0, MAX_NAME_LEN), source: 'text' as const, text: capText(json.text) }
  }
  return null
}

// Upload into a specific KB.
documentsRoute.post('/knowledge-bases/:kbId/documents', async (c) => {
  const orgId = c.get('orgId')
  const kb = await getKbInOrg(c.req.param('kbId'), orgId)
  if (!kb) return c.json({ error: 'knowledge base not found' }, 404)

  let upload
  try {
    upload = await readUpload(c)
  } catch (err) {
    if (err instanceof UploadTooLarge) return c.json({ error: err.message }, 413)
    throw err
  }
  if (!upload) return c.json({ error: 'provide a `file` (multipart) or `text` (json/form)' }, 400)

  const doc = await createAndIngest(kb.id, upload.name, upload.source, upload.text)
  return c.json({ documentId: doc.id, name: doc.name, status: doc.status }, 202)
})

// Convenience: upload into the agent's private (default) KB.
documentsRoute.post('/agents/:id/documents', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  // Deterministic: a private KB has an explicit owner + a unique constraint, so
  // this resolves to exactly one row (no ambiguous LIMIT 1 over a join).
  const [defaultKb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.agentId, agent.id), eq(knowledgeBases.isDefault, true)))
    .limit(1)
  if (!defaultKb) return c.json({ error: 'agent has no private KB' }, 500)

  let upload
  try {
    upload = await readUpload(c)
  } catch (err) {
    if (err instanceof UploadTooLarge) return c.json({ error: err.message }, 413)
    throw err
  }
  if (!upload) return c.json({ error: 'provide a `file` (multipart) or `text` (json/form)' }, 400)

  const doc = await createAndIngest(defaultKb.id, upload.name, upload.source, upload.text)
  return c.json({ documentId: doc.id, name: doc.name, status: doc.status, knowledgeBaseId: defaultKb.id }, 202)
})

// List documents in a KB.
documentsRoute.get('/knowledge-bases/:kbId/documents', async (c) => {
  const orgId = c.get('orgId')
  const kb = await getKbInOrg(c.req.param('kbId'), orgId)
  if (!kb) return c.json({ error: 'knowledge base not found' }, 404)

  const rows = await db.select().from(documents).where(eq(documents.knowledgeBaseId, kb.id))
  return c.json(rows)
})

// Delete a document (cascades to its chunks).
documentsRoute.delete('/knowledge-bases/:kbId/documents/:docId', async (c) => {
  const orgId = c.get('orgId')
  const kb = await getKbInOrg(c.req.param('kbId'), orgId)
  if (!kb) return c.json({ error: 'knowledge base not found' }, 404)

  await db
    .delete(documents)
    .where(and(eq(documents.id, c.req.param('docId')), eq(documents.knowledgeBaseId, kb.id)))
  return c.json({ ok: true })
})
