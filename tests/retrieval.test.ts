import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { documents, chunks } from '../src/db/schema'
import { searchChunks } from '../src/services/retrieve'

// 8-dim vectors (EMBEDDING_DIM=8 in the test env). One-hot vectors are unit-norm,
// so cosine similarity is 1 for identical and 0 for orthogonal.
const oneHot = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0))

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

async function seedChunk(kbId: string, embedding: number[], content: string) {
  const [doc] = await db
    .insert(documents)
    .values({ knowledgeBaseId: kbId, name: 'doc', source: 'text', status: 'ready' })
    .returning({ id: documents.id })
  await db.insert(chunks).values({ documentId: doc!.id, knowledgeBaseId: kbId, content, embedding })
}

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('retrieval', () => {
  it('returns chunks ordered by similarity, drops sub-threshold, and stays within the agent’s KB set', async () => {
    const org = (await api('POST', '/organizations', undefined, { name: 'retrieval-org' })).json
    const agentA = (await api('POST', '/agents', org.apiKey, { name: 'a' })).json
    const agentB = (await api('POST', '/agents', org.apiKey, { name: 'b' })).json

    const query = oneHot(0)
    // KB A: one on-topic chunk (sim 1) and one orthogonal chunk (sim 0, below the
    // 0.2 default floor → must be dropped).
    await seedChunk(agentA.privateKbId, oneHot(0), 'relevant-A')
    await seedChunk(agentA.privateKbId, oneHot(3), 'irrelevant-A')
    // KB B belongs to another agent; an on-topic chunk there must NOT leak into A.
    await seedChunk(agentB.privateKbId, oneHot(0), 'relevant-B')

    const hits = await searchChunks(agentA.agent.id, query, 6)
    const contents = hits.map((h) => h.content)

    expect(contents).toContain('relevant-A')
    expect(contents).not.toContain('irrelevant-A') // dropped by RETRIEVAL_MIN_SIMILARITY
    expect(contents).not.toContain('relevant-B') // KB scoping: not in agent A's set
    // Top hit is the exact match.
    expect(hits[0]!.content).toBe('relevant-A')
    expect(hits[0]!.similarity).toBeGreaterThan(0.99)
  })

  it('returns nothing for an agent with no linked chunks', async () => {
    const org = (await api('POST', '/organizations', undefined, { name: 'empty-org' })).json
    const agent = (await api('POST', '/agents', org.apiKey, { name: 'empty' })).json
    expect(await searchChunks(agent.agent.id, oneHot(0), 6)).toEqual([])
  })
})
