import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { app } from '../src/index'
import { assertLegacyPrivateKbOwnershipIsUnambiguous, migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { agents, agentKnowledgeBases, conversations, knowledgeBases, memories, organizations } from '../src/db/schema'
import { recallMemories } from '../src/services/memory'
import { prepareChatTurn, ChatError } from '../src/services/chat'
import { encryptLegacyLlmSecrets } from '../src/services/secrets'
import { decryptSecret } from '../src/lib/crypto'

// One-hot 8-dim vectors (EMBEDDING_DIM=8 in test env) — distinct but valid.
const vec = (seed = 0) => Array.from({ length: 8 }, (_, i) => (i === seed ? 1 : 0))

async function api(method: string, path: string, key?: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  const json = await res.json().catch(() => null)
  return { status: res.status, json: json as any }
}

async function createOrg(name: string): Promise<{ id: string; key: string }> {
  const { json } = await api('POST', '/organizations', 'test-admin-token', { name })
  return { id: json.id, key: json.apiKey }
}

async function createAgent(key: string, name: string): Promise<{ id: string; privateKbId: string }> {
  const { json } = await api('POST', '/agents', key, { name })
  return { id: json.agent.id, privateKbId: json.privateKbId }
}

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('organization isolation', () => {
  it('org B cannot read org A’s agent', async () => {
    const orgA = await createOrg('A')
    const orgB = await createOrg('B')
    const agentA = await createAgent(orgA.key, 'agent-a')

    expect((await api('GET', `/agents/${agentA.id}`, orgA.key)).status).toBe(200)
    expect((await api('GET', `/agents/${agentA.id}`, orgB.key)).status).toBe(404)
    expect((await api('GET', `/agents/${agentA.id}/knowledge-bases`, orgB.key)).status).toBe(404)
  })
})

describe('private knowledge base isolation (P0 #1)', () => {
  it('refuses to link a private KB to another agent (same org)', async () => {
    const org = await createOrg('org')
    const a = await createAgent(org.key, 'a')
    const b = await createAgent(org.key, 'b')

    const res = await api('POST', `/agents/${b.id}/knowledge-bases`, org.key, { knowledgeBaseId: a.privateKbId })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toMatch(/private KB/i)
  })

  it('links a SHARED KB, but not across orgs', async () => {
    const orgA = await createOrg('orgA')
    const orgB = await createOrg('orgB')
    const a = await createAgent(orgA.key, 'a')
    const bAgent = await createAgent(orgB.key, 'b')

    const shared = await api('POST', '/knowledge-bases', orgA.key, { name: 'policies' })
    expect(shared.status).toBe(201)

    // same-org link to a shared KB works
    expect((await api('POST', `/agents/${a.id}/knowledge-bases`, orgA.key, { knowledgeBaseId: shared.json.id })).status).toBe(201)

    // org B cannot even see org A's shared KB → 404 (not 403 leak of existence)
    const cross = await api('POST', `/agents/${bAgent.id}/knowledge-bases`, orgB.key, { knowledgeBaseId: shared.json.id })
    expect(cross.status).toBe(404)
  })

  it('the database forbids a second private KB per agent and an ownerless private KB', async () => {
    const org = await createOrg('org')
    const a = await createAgent(org.key, 'a')

    // second private KB owned by the same agent → unique violation
    await expect(
      db.insert(knowledgeBases).values({ orgId: org.id, name: 'dupe', isDefault: true, agentId: a.id }),
    ).rejects.toThrow()

    // private KB with no owner → check-constraint violation
    await expect(
      db.insert(knowledgeBases).values({ orgId: org.id, name: 'ownerless', isDefault: true }),
    ).rejects.toThrow()
  })

  it('the database blocks a direct same-org cross-agent private link (trigger)', async () => {
    const org = await createOrg('org')
    const a = await createAgent(org.key, 'a')
    const b = await createAgent(org.key, 'b')

    // Agent B → agent A's PRIVATE KB, same org, correct org_id (so the composite
    // FKs are satisfied). Only the trigger stands between this and a data leak.
    await expect(
      db.insert(agentKnowledgeBases).values({ agentId: b.id, knowledgeBaseId: a.privateKbId, orgId: org.id }),
    ).rejects.toThrow()
  })

  it('the database blocks changing a linked private KB owner', async () => {
    const org = await createOrg('owner-mutation-org')
    const a = await createAgent(org.key, 'owner-a')
    const [b] = await db
      .insert(agents)
      .values({ orgId: org.id, name: 'owner-b-without-private-kb' })
      .returning({ id: agents.id })

    await expect(
      db
        .update(knowledgeBases)
        .set({ agentId: b!.id })
        .where(eq(knowledgeBases.id, a.privateKbId)),
    ).rejects.toThrow()
  })

  it('the database blocks converting a multiply-linked shared KB to private', async () => {
    const org = await createOrg('shared-mutation-org')
    const a = await createAgent(org.key, 'shared-a')
    const [b] = await db
      .insert(agents)
      .values({ orgId: org.id, name: 'shared-b-without-private-kb' })
      .returning({ id: agents.id })
    const shared = await api('POST', '/knowledge-bases', org.key, { name: 'shared' })

    expect((await api('POST', `/agents/${a.id}/knowledge-bases`, org.key, { knowledgeBaseId: shared.json.id })).status).toBe(201)
    await db
      .insert(agentKnowledgeBases)
      .values({ agentId: b!.id, knowledgeBaseId: shared.json.id, orgId: org.id })

    await expect(
      db
        .update(knowledgeBases)
        .set({ isDefault: true, agentId: b!.id })
        .where(eq(knowledgeBases.id, shared.json.id)),
    ).rejects.toThrow()
  })

  it('legacy ownership preflight refuses ambiguous private-KB links', async () => {
    const org = await createOrg('legacy-ambiguity-org')
    const a = await createAgent(org.key, 'legacy-a')
    const b = await createAgent(org.key, 'legacy-b')

    await sql`ALTER TABLE agent_knowledge_bases DISABLE TRIGGER USER`
    try {
      await db
        .insert(agentKnowledgeBases)
        .values({ agentId: b.id, knowledgeBaseId: a.privateKbId, orgId: org.id })
      await expect(assertLegacyPrivateKbOwnershipIsUnambiguous()).rejects.toThrow(
        /cannot infer private knowledge-base ownership safely/i,
      )
      await db
        .delete(agentKnowledgeBases)
        .where(eq(agentKnowledgeBases.knowledgeBaseId, a.privateKbId))
      await db
        .insert(agentKnowledgeBases)
        .values({ agentId: a.id, knowledgeBaseId: a.privateKbId, orgId: org.id })
    } finally {
      await sql`ALTER TABLE agent_knowledge_bases ENABLE TRIGGER USER`
    }
  })

  it('the database forbids a cross-org agent↔KB link', async () => {
    const orgA = await createOrg('orgA')
    const orgB = await createOrg('orgB')
    const a = await createAgent(orgA.key, 'a')
    const sharedB = await api('POST', '/knowledge-bases', orgB.key, { name: 'kbB' })

    // agent in org A, KB in org B — composite FKs make this impossible regardless of org_id value.
    await expect(
      db.insert(agentKnowledgeBases).values({ agentId: a.id, knowledgeBaseId: sharedB.json.id, orgId: orgA.id }),
    ).rejects.toThrow()
  })
})

describe('per-user memory isolation (P0 #2)', () => {
  it('recall returns this user’s facts + agent-wide, never another user’s', async () => {
    const org = await createOrg('org')
    const a = await createAgent(org.key, 'a')

    await db.insert(memories).values([
      { agentId: a.id, endUserId: 'alice', fact: 'alice-secret', embedding: vec(0) },
      { agentId: a.id, endUserId: 'bob', fact: 'bob-secret', embedding: vec(1) },
      { agentId: a.id, endUserId: null, fact: 'company-wide', embedding: vec(2) },
    ])

    const forAlice = await recallMemories(a.id, 'alice', vec(0), 10)
    expect(forAlice).toContain('alice-secret')
    expect(forAlice).toContain('company-wide')
    expect(forAlice).not.toContain('bob-secret')

    const forBob = await recallMemories(a.id, 'bob', vec(1), 10)
    expect(forBob).toContain('bob-secret')
    expect(forBob).toContain('company-wide')
    expect(forBob).not.toContain('alice-secret')
  })
})

describe('conversation identity binding (P0 #3)', () => {
  it('rejects continuing another user’s conversation', async () => {
    const org = await createOrg('org')
    const a = await createAgent(org.key, 'a')
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, a.id)).limit(1)

    const [conv] = await db
      .insert(conversations)
      .values({ agentId: a.id, endUserId: 'alice' })
      .returning({ id: conversations.id })

    // Bob presents Alice's conversation id → must be refused before any work.
    await expect(
      prepareChatTurn({ agent: agentRow!, endUserId: 'bob', message: 'hi', conversationId: conv!.id }),
    ).rejects.toMatchObject({ status: 403 })

    // An unknown conversation id → 404.
    await expect(
      prepareChatTurn({
        agent: agentRow!,
        endUserId: 'alice',
        message: 'hi',
        conversationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(ChatError)
  })
})

describe('LLM credential encryption at rest', () => {
  it('migrates an existing plaintext credential and records encrypted state', async () => {
    const org = await createOrg('legacy-secret-org')
    await db
      .update(organizations)
      .set({ llmApiKey: 'legacy-plaintext-secret', llmApiKeyEncrypted: false })
      .where(eq(organizations.id, org.id))

    expect(await encryptLegacyLlmSecrets()).toBeGreaterThanOrEqual(1)

    const [stored] = await db
      .select({
        apiKey: organizations.llmApiKey,
        encrypted: organizations.llmApiKeyEncrypted,
      })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1)

    expect(stored!.encrypted).toBe(true)
    expect(stored!.apiKey).not.toContain('legacy-plaintext-secret')
    expect(decryptSecret(stored!.apiKey!, stored!.encrypted)).toBe('legacy-plaintext-secret')
  })
})
