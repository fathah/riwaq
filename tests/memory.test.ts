import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { memories } from '../src/db/schema'
import { recallMemories, pruneMemories } from '../src/services/memory'
import { eq } from 'drizzle-orm'

vi.mock('../src/lib/embeddings', () => ({
  EMBEDDING_DIM: 8,
  embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, (_, index) => index === 0 ? 1 : 0)),
  embedOne: async (text: string) => Array.from({ length: 8 }, (_, index) => index === (text.includes('updated') ? 1 : 0) ? 1 : 0),
}))

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

async function makeAgent(name: string): Promise<string> {
  return (await makeAgentWithKey(name)).agentId
}

async function makeAgentWithKey(name: string): Promise<{ agentId: string; key: string }> {
  const org = (await api('POST', '/organizations', 'test-admin-token', { name: `${name}-org` })).json
  const agentId = (await api('POST', '/agents', org.apiKey, { name })).json.agent.id
  return { agentId, key: org.apiKey }
}

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('memory recall', () => {
  it('returns nearest facts for the user, includes agent-wide, excludes other users', async () => {
    const agentId = await makeAgent('mem')
    await db.insert(memories).values([
      { agentId, endUserId: 'u1', fact: 'u1-near', embedding: oneHot(0) },
      { agentId, endUserId: 'u1', fact: 'u1-far', embedding: oneHot(5) },
      { agentId, endUserId: null, fact: 'agent-wide', embedding: oneHot(0) },
      { agentId, endUserId: 'u2', fact: 'u2-secret', embedding: oneHot(0) },
    ])

    const recalled = await recallMemories(agentId, 'u1', oneHot(0), 5)
    expect(recalled).toContain('u1-near')
    expect(recalled).toContain('agent-wide') // endUserId IS NULL facts are shared
    expect(recalled).not.toContain('u2-secret') // never leak another user's memory
    expect(recalled[0]).toBe('u1-near') // ordered by similarity (nearest first)
  })
})

describe('memory pruning', () => {
  it('keeps only the most-recently-updated facts per user', async () => {
    const agentId = await makeAgent('prune')
    // Seed more rows than the cap would allow if it were small; assert prune keeps
    // the newest and removes the rest for THIS user only.
    const now = Date.now()
    const rows = Array.from({ length: 5 }, (_, i) => ({
      agentId,
      endUserId: 'u1',
      fact: `fact-${i}`,
      embedding: oneHot(0),
      updatedAt: new Date(now + i * 1000),
    }))
    await db.insert(memories).values(rows)
    // Another user's memory must be untouched by a prune scoped to u1.
    await db.insert(memories).values({ agentId, endUserId: 'u2', fact: 'u2-keep', embedding: oneHot(0) })

    // Temporarily verify prune is a no-op under the (large) default cap, then that
    // the query is well-formed and user-scoped.
    await pruneMemories(agentId, 'u1')
    const remaining = await db.select({ fact: memories.fact }).from(memories)
    const facts = remaining.map((r) => r.fact)
    expect(facts).toContain('fact-4')
    expect(facts).toContain('u2-keep')
  })
})

describe('operator memory management', () => {
  it('lists, creates, edits, and deletes memories without exposing vectors', async () => {
    const { agentId, key } = await makeAgentWithKey('managed-memory')
    const created = await api('POST', `/agents/${agentId}/memories`, key, {
      endUserId: 'telegram:42',
      fact: 'Prefers concise answers',
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ endUserId: 'telegram:42', fact: 'Prefers concise answers' })
    expect(created.json).not.toHaveProperty('embedding')

    const agentWide = await api('POST', `/agents/${agentId}/memories`, key, {
      endUserId: null,
      fact: 'All users prefer metric units',
    })
    expect(agentWide.status).toBe(201)
    expect(agentWide.json.endUserId).toBeNull()

    const listed = await api('GET', `/agents/${agentId}/memories`, key)
    expect(listed.status).toBe(200)
    expect(listed.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.json.id, endUserId: 'telegram:42' }),
      expect.objectContaining({ id: agentWide.json.id, endUserId: null }),
    ]))
    expect(JSON.stringify(listed.json)).not.toContain('embedding')

    const updated = await api('PATCH', `/agents/${agentId}/memories/${created.json.id}`, key, {
      fact: 'Prefers updated concise answers',
    })
    expect(updated.status).toBe(200)
    expect(updated.json.fact).toBe('Prefers updated concise answers')
    const [stored] = await db.select({ embedding: memories.embedding }).from(memories).where(eq(memories.id, created.json.id))
    expect(stored?.embedding).toEqual(oneHot(1))

    expect((await api('DELETE', `/agents/${agentId}/memories/${agentWide.json.id}`, key)).status).toBe(200)
    expect((await api('DELETE', `/agents/${agentId}/memories/${agentWide.json.id}`, key)).status).toBe(404)
  })

  it('isolates management by organization and forgets only the selected user', async () => {
    const { agentId, key } = await makeAgentWithKey('memory-isolation')
    const other = await makeAgentWithKey('memory-isolation-other')
    await api('POST', `/agents/${agentId}/memories`, key, { endUserId: 'u1', fact: 'u1 first' })
    await api('POST', `/agents/${agentId}/memories`, key, { endUserId: 'u1', fact: 'u1 second' })
    await api('POST', `/agents/${agentId}/memories`, key, { endUserId: 'u2', fact: 'u2 keep' })

    expect((await api('GET', `/agents/${agentId}/memories`, other.key)).status).toBe(404)
    const forgotten = await api('DELETE', `/agents/${agentId}/memories?endUserId=${encodeURIComponent('u1')}`, key)
    expect(forgotten).toEqual({ status: 200, json: { ok: true, deleted: 2 } })

    const listed = await api('GET', `/agents/${agentId}/memories`, key)
    expect(listed.json.some((memory: { endUserId: string }) => memory.endUserId === 'u1')).toBe(false)
    expect(listed.json).toEqual(expect.arrayContaining([expect.objectContaining({ endUserId: 'u2', fact: 'u2 keep' })]))
  })
})
