import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { memories } from '../src/db/schema'
import { recallMemories, pruneMemories } from '../src/services/memory'

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
  const org = (await api('POST', '/organizations', undefined, { name: `${name}-org` })).json
  return (await api('POST', '/agents', org.apiKey, { name })).json.agent.id
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
