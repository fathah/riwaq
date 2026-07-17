import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { chunks, documents } from '../src/db/schema'
import { createAndIngest, IngestQueueUnavailable } from '../src/routes/documents'
import { desc, eq } from 'drizzle-orm'

async function api(method: string, path: string, key?: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

let key: string
let agentId: string
let orgId: string

beforeAll(async () => {
  await migrate()
  const org = (await api('POST', '/organizations', 'test-admin-token', { name: 'routes-org' })).json
  key = org.apiKey
  orgId = org.id
  agentId = (await api('POST', '/agents', key, { name: 'r' })).json.agent.id
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('malformed UUID path params → 404, never 500', () => {
  it('GET /agents/:id with a non-uuid id', async () => {
    expect((await api('GET', '/agents/not-a-uuid', key)).status).toBe(404)
  })
  it('POST /messages/:id/feedback with a non-uuid id', async () => {
    const res = await api('POST', '/messages/not-a-uuid/feedback', key, { rating: 'up' })
    expect(res.status).toBe(404)
  })
  it('DELETE /knowledge-bases/:kbId/documents/:docId with a non-uuid docId', async () => {
    // Use a real KB so the 404 comes from the docId check, not the KB check.
    const kbId = (await api('GET', `/agents/${agentId}/knowledge-bases`, key)).json[0].id
    const res = await api('DELETE', `/knowledge-bases/${kbId}/documents/not-a-uuid`, key)
    expect(res.status).toBe(404)
  })
})

describe('OpenAI-compatible error envelopes', () => {
  it('rejects a malformed body with a 400 in the OpenAI error shape', async () => {
    const res = await api('POST', '/v1/chat/completions', key, { model: 123 })
    expect(res.status).toBe(400)
    expect(res.json.error).toMatchObject({ type: 'invalid_request_error' })
    expect(typeof res.json.error.message).toBe('string')
  })

  it('requires an identity (no shared anonymous bucket)', async () => {
    const res = await api('POST', '/v1/chat/completions', key, {
      model: agentId,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('missing_user')
  })

  it('unknown model → 404 model_not_found', async () => {
    const res = await api('POST', '/v1/chat/completions', key, {
      model: 'nonexistent-agent',
      messages: [{ role: 'user', content: 'hi' }],
      user: 'u1',
    })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('model_not_found')
  })
})

describe('first-party agent listing', () => {
  it('lists only agents owned by the authenticated organization', async () => {
    const res = await api('GET', '/agents', key)
    expect(res.status).toBe(200)
    expect(res.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: agentId, name: 'r' })]))
  })

  it('updates and clears the agent system prompt', async () => {
    const updated = await api('PATCH', `/agents/${agentId}`, key, {
      systemPrompt: 'Answer in no more than 50 words.',
    })
    expect(updated.status).toBe(200)
    expect(updated.json.systemPrompt).toBe('Answer in no more than 50 words.')
    expect((await api('GET', `/agents/${agentId}`, key)).json.systemPrompt).toBe('Answer in no more than 50 words.')

    const cleared = await api('PATCH', `/agents/${agentId}`, key, { systemPrompt: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.json.systemPrompt).toBe('')
  })
})

describe('knowledge document inspection', () => {
  it('returns document metadata and indexed text without embedding vectors', async () => {
    const kbId = (await api('GET', `/agents/${agentId}/knowledge-bases`, key)).json[0].id
    const [document] = await db
      .insert(documents)
      .values({ knowledgeBaseId: kbId, name: 'handbook.txt', source: 'text', status: 'ready' })
      .returning({ id: documents.id })
    await db.insert(chunks).values({
      documentId: document!.id,
      knowledgeBaseId: kbId,
      content: 'Refunds are available within 30 days.',
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      metadata: { index: 0 },
    })

    const res = await api('GET', `/knowledge-bases/${kbId}/documents/${document!.id}`, key)
    expect(res.status).toBe(200)
    expect(res.json.document).toMatchObject({ id: document!.id, name: 'handbook.txt', status: 'ready' })
    expect(res.json.chunks).toEqual([expect.objectContaining({ content: 'Refunds are available within 30 days.' })])
    expect(JSON.stringify(res.json)).not.toContain('embedding')
  })

  it('marks a document as failed when its ingestion job cannot be queued', async () => {
    const kbId = (await api('GET', `/agents/${agentId}/knowledge-bases`, key)).json[0].id
    await expect(
      createAndIngest(orgId, kbId, 'queue failure', 'text', 'A short sentence.', async () => {
        throw new Error('queue unavailable')
      }),
    ).rejects.toBeInstanceOf(IngestQueueUnavailable)

    const [document] = await db
      .select({ name: documents.name, status: documents.status })
      .from(documents)
      .where(eq(documents.knowledgeBaseId, kbId))
      .orderBy(desc(documents.createdAt))
      .limit(1)
    expect(document).toEqual({ name: 'queue failure', status: 'error' })
  })
})

describe('admin organization management', () => {
  it('requires the configured admin token', async () => {
    expect((await api('GET', '/admin/organizations')).status).toBe(401)
  })

  it('lists organizations without exposing API-key hashes', async () => {
    const res = await api('GET', '/admin/organizations', 'test-admin-token')
    expect(res.status).toBe(200)
    expect(res.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: orgId, name: 'routes-org' })]))
    expect(JSON.stringify(res.json)).not.toContain('apiKeyHash')
  })

  it('allows admin-scoped organization selection without rotating its API key', async () => {
    const res = await api('GET', '/organizations/me', undefined, undefined, {
      'x-admin-token': 'test-admin-token',
      'x-riwaq-organization-id': orgId,
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ id: orgId, name: 'routes-org' })
  })

  it('renames an organization through the admin route', async () => {
    const renamed = await api('PATCH', `/admin/organizations/${orgId}`, 'test-admin-token', { name: 'routes-org-renamed' })
    expect(renamed.status).toBe(200)
    expect(renamed.json.name).toBe('routes-org-renamed')
    expect((await api('GET', '/organizations/me', key)).json.name).toBe('routes-org-renamed')
  })
})
