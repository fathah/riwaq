import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { conversations, messages, topics } from '../src/db/schema'
import { classifyQuestion } from '../src/services/topics'
import type { LlmConfig } from '../src/lib/llm'

const dummyLlm: LlmConfig = { provider: 'anthropic', model: 'm', apiKey: 'k' }

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

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('topic clustering', () => {
  it('moves a matched cluster’s centroid toward the new question (running mean)', async () => {
    const org = (await api('POST', '/organizations', 'test-admin-token', { name: 'topics-org' })).json
    const agent = (await api('POST', '/agents', org.apiKey, { name: 't' })).json.agent

    // A pre-seeded topic centroid = [1,0,0,0,0,0,0,0], count 1.
    const centroid = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0))
    const [topic] = await db
      .insert(topics)
      .values({ agentId: agent.id, label: 'seed', centroid, count: 1 })
      .returning({ id: topics.id })

    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, endUserId: 'u1' })
      .returning({ id: conversations.id })
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, role: 'user', content: 'q' })
      .returning({ id: messages.id })

    // A question similar (cos ≈ 0.71 ≥ 0.6 threshold) but not identical to the
    // centroid → it joins the cluster AND should pull the centroid toward it.
    const question = [1, 1, 0, 0, 0, 0, 0, 0]
    const { topicId } = await classifyQuestion({
      agentId: agent.id,
      messageId: msg!.id,
      question: 'q',
      embedding: question,
      llm: dummyLlm,
    })

    expect(topicId).toBe(topic!.id) // matched the existing cluster, no new one

    const [after] = await db
      .select({ count: topics.count, centroid: topics.centroid })
      .from(topics)
      .where(eq(topics.id, topic!.id))
    expect(after!.count).toBe(2)
    // Second component was 0; the running-mean update must have moved it up.
    expect(after!.centroid[1]).toBeGreaterThan(0)
    // First component stays high (still the dominant direction).
    expect(after!.centroid[0]).toBeGreaterThan(0.9)
  })

  it('is idempotent: re-running the same message does not double-count', async () => {
    const org = (await api('POST', '/organizations', 'test-admin-token', { name: 'topics-org2' })).json
    const agent = (await api('POST', '/agents', org.apiKey, { name: 't2' })).json.agent

    const centroid = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0))
    const [topic] = await db
      .insert(topics)
      .values({ agentId: agent.id, label: 'seed', centroid, count: 1 })
      .returning({ id: topics.id })
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, endUserId: 'u1' })
      .returning({ id: conversations.id })
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, role: 'user', content: 'q' })
      .returning({ id: messages.id })

    const embedding = [1, 0.2, 0, 0, 0, 0, 0, 0]
    const args = { agentId: agent.id, messageId: msg!.id, question: 'q', embedding, llm: dummyLlm }
    await classifyQuestion(args)
    await classifyQuestion(args) // delivered twice (durable-queue semantics)

    const [after] = await db.select({ count: topics.count }).from(topics).where(eq(topics.id, topic!.id))
    expect(after!.count).toBe(2) // incremented once, not twice
  })
})
