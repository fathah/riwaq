import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'

// Self-learning embeds questions/answers internally. Mock the embedder so tests are
// deterministic and offline: identical text → identical vector (so equivalent
// questions cluster), different text → (usually) different vector.
vi.mock('../src/lib/embeddings', () => {
  const oneHot = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0))
  const bucket = (s: string) => {
    let h = 0
    for (const ch of s) h = (h + ch.charCodeAt(0)) % 8
    return h
  }
  return {
    EMBEDDING_DIM: 8,
    embed: async (texts: string[]) => texts.map((t) => oneHot(bucket(t))),
    embedOne: async (t: string) => oneHot(bucket(t)),
  }
})

const { app } = await import('../src/index')
const { migrate } = await import('../src/db/migrate')
const { db, sql } = await import('../src/db/client')
const schema = await import('../src/db/schema')
const { captureUpvote } = await import('../src/services/learning')

const { learnedAnswers, documents, organizations, conversations, messages, questionLogs, topics } = schema

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

async function makeOrgAgent(name: string) {
  const org = (await api('POST', '/organizations', 'test-admin-token', { name: `${name}-org` })).json
  const agent = (await api('POST', '/agents', org.apiKey, { name })).json
  return { orgId: org.id, key: org.apiKey, agentId: agent.agent.id, privateKbId: agent.privateKbId }
}

async function waitFor(fn: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return false
}

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('self-learning: distinct-user endorsement', () => {
  it('counts distinct users and auto-promotes once the org threshold is met', async () => {
    const a = await makeOrgAgent('auto')
    await db.update(organizations).set({ learnedAutoPromoteThreshold: 2 }).where(eq(organizations.id, a.orgId))

    const q = 'what are your business hours?'
    const ans = 'We are open 9-5, Monday to Friday.'

    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u1', question: q, answer: ans })
    // One endorsement: still pending (threshold is 2).
    let [row] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))
    expect(row!.status).toBe('pending')
    expect(row!.distinctUserCount).toBe(1)

    // A second, DISTINCT user endorses the same question → threshold met → promoted.
    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u2', question: q, answer: ans })
    ;[row] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))
    expect(row!.distinctUserCount).toBe(2)
    expect(row!.status).toBe('approved')
    expect(row!.promotedDocumentId).not.toBeNull()

    // The Q&A entered the agent's KB as a 'learned' document and gets ingested.
    const ingested = await waitFor(async () => {
      const [doc] = await db.select().from(documents).where(eq(documents.id, row!.promotedDocumentId!))
      return doc?.status === 'ready'
    })
    expect(ingested).toBe(true)
    const [learnedDoc] = await db.select().from(documents).where(eq(documents.id, row!.promotedDocumentId!))
    expect(learnedDoc!.source).toBe('learned')
  })

  it('does not inflate the count when the same user endorses repeatedly', async () => {
    const a = await makeOrgAgent('repeat')
    const q = 'do you ship internationally?'
    for (let i = 0; i < 3; i++) {
      await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'same-user', question: q, answer: 'Yes.' })
    }
    const [row] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))
    expect(row!.distinctUserCount).toBe(1)
    expect(row!.status).toBe('pending')
  })
})

describe('self-learning: operator approval', () => {
  it('lists a pending candidate and promotes it on approval', async () => {
    const a = await makeOrgAgent('approve') // threshold 0 → approval required
    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u1', question: 'refund policy?', answer: '30 days.' })

    const pending = (await api('GET', `/agents/${a.agentId}/learned-answers?status=pending`, a.key)).json
    expect(pending).toHaveLength(1)
    const laId = pending[0].id

    const approved = await api('POST', `/agents/${a.agentId}/learned-answers/${laId}/approve`, a.key)
    expect(approved.status).toBe(200)

    const [row] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.id, laId))
    expect(row!.status).toBe('approved')
    expect(row!.promotedDocumentId).not.toBeNull()
    // Approving again is a no-op (already promoted), not a double-promotion.
    const again = await api('POST', `/agents/${a.agentId}/learned-answers/${laId}/approve`, a.key)
    expect(again.status).toBe(404)
  })

  it('rejected candidates are not re-clustered by later endorsements', async () => {
    const a = await makeOrgAgent('reject')
    const q = 'is there a free trial?'
    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u1', question: q, answer: 'Yes, 14 days.' })
    const [first] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))

    const rejected = await api('POST', `/agents/${a.agentId}/learned-answers/${first!.id}/reject`, a.key)
    expect(rejected.status).toBe(200)

    // Same question endorsed again → a NEW pending candidate, not the rejected one.
    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u2', question: q, answer: 'Yes, 14 days.' })
    const rows = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1)
  })

  it('another org cannot see or approve this agent’s candidates', async () => {
    const a = await makeOrgAgent('victim')
    await captureUpvote({ orgId: a.orgId, agentId: a.agentId, endUserId: 'u1', question: 'x?', answer: 'y' })
    const [row] = await db.select().from(learnedAnswers).where(eq(learnedAnswers.agentId, a.agentId))
    const other = await makeOrgAgent('attacker')
    expect((await api('GET', `/agents/${a.agentId}/learned-answers`, other.key)).status).toBe(404)
    expect((await api('POST', `/agents/${a.agentId}/learned-answers/${row!.id}/approve`, other.key)).status).toBe(404)
  })
})

describe('self-learning: report', () => {
  it('surfaces knowledge gaps and answer coverage', async () => {
    const a = await makeOrgAgent('report')
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: a.agentId, endUserId: 'u1' })
      .returning({ id: conversations.id })
    const [topic] = await db
      .insert(topics)
      .values({ agentId: a.agentId, label: 'Shipping', centroid: Array(8).fill(0), count: 0 })
      .returning({ id: topics.id })

    // Two well-answered questions (high similarity) + two gaps (low similarity).
    const sims = [0.9, 0.8, 0.05, 0.1]
    for (const s of sims) {
      const [m] = await db
        .insert(messages)
        .values({ conversationId: conv!.id, role: 'user', content: 'q' })
        .returning({ id: messages.id })
      await db.insert(questionLogs).values({
        agentId: a.agentId,
        messageId: m!.id,
        topicId: topic!.id,
        embedding: Array(8).fill(0),
        topSimilarity: s,
      })
    }

    const report = (await api('GET', `/agents/${a.agentId}/analytics/learning`, a.key)).json
    expect(report.coverage.totalQuestions).toBe(4)
    expect(report.coverage.unanswered).toBe(2) // the two below the gap floor
    expect(report.coverage.answered).toBe(2)
    expect(report.gaps[0]).toMatchObject({ topic: 'Shipping', count: 2 })
  })
})
