import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { sql } from '../src/db/client'

async function api(method: string, path: string, key?: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

let key: string
let agentId: string

beforeAll(async () => {
  await migrate()
  const org = (await api('POST', '/organizations', undefined, { name: 'routes-org' })).json
  key = org.apiKey
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
