import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { sql } from '../src/db/client'
import { resolvePlatformUser } from '../src/services/users'

vi.mock('../src/lib/embeddings', () => ({
  EMBEDDING_DIM: 8,
  embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
  embedOne: async () => [1, 0, 0, 0, 0, 0, 0, 0],
}))

async function api(method: string, path: string, key?: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  return { status: response.status, json: await response.json().catch(() => null) as any }
}

async function organization(name: string) {
  const created = await api('POST', '/organizations', 'test-admin-token', { name })
  const agent = await api('POST', '/agents', created.json.apiKey, { name: `${name}-agent` })
  return { orgId: created.json.id as string, key: created.json.apiKey as string, agentId: agent.json.agent.id as string }
}

beforeAll(async () => { await migrate() })
afterAll(async () => { await sql.end({ timeout: 5 }) })

describe('organization users', () => {
  it('idempotently connects a business user to an external identity', async () => {
    const first = await organization('users-connect')
    const input = {
      userId: 'customer_4821',
      displayName: 'Amina Rahman',
      provider: 'shopify',
      namespace: 'store_in',
      externalUserId: 'gid://shopify/Customer/42',
    }
    expect(await api('POST', '/users/connect', first.key, input)).toMatchObject({
      status: 200,
      json: { userId: 'customer_4821', mergedFrom: null, identity: { provider: 'shopify', namespace: 'store_in' } },
    })
    expect((await api('POST', '/users/connect', first.key, input)).status).toBe(200)
    expect(await resolvePlatformUser({
      orgId: first.orgId,
      provider: 'shopify',
      namespace: 'store_in',
      externalUserId: 'gid://shopify/Customer/42',
      fallbackUserId: 'shopify:42',
    })).toBe('customer_4821')

    const detail = await api('GET', '/users/customer_4821', first.key)
    expect(detail.json.user).toMatchObject({ id: 'customer_4821', displayName: 'Amina Rahman', identityCount: 1 })
    expect(detail.json.identities).toHaveLength(1)
    expect((await api('GET', '/users', first.key)).json).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'customer_4821', identityCount: 1 }),
    ]))

    const second = await organization('users-connect-other')
    expect((await api('GET', '/users/customer_4821', second.key)).status).toBe(404)
    // The same provider identity is valid in another organization.
    expect((await api('POST', '/users/connect', second.key, input)).status).toBe(200)
  })

  it('migrates an auto-created platform user and durable memories when linked later', async () => {
    const { key, agentId } = await organization('users-merge')
    await api('POST', '/users/connect', key, {
      userId: 'telegram:99',
      provider: 'telegram',
      externalUserId: '99',
    })
    const memory = await api('POST', `/agents/${agentId}/memories`, key, {
      endUserId: 'telegram:99',
      fact: 'Prefers delivery after 6 PM',
    })
    expect(memory.status).toBe(201)

    const conflict = await api('POST', '/users/connect', key, {
      userId: 'customer_99',
      provider: 'telegram',
      externalUserId: '99',
    })
    expect(conflict.status).toBe(409)

    const merged = await api('POST', '/users/connect', key, {
      userId: 'customer_99',
      displayName: 'Telegram Customer',
      provider: 'telegram',
      externalUserId: '99',
      mergeExisting: true,
    })
    expect(merged).toMatchObject({ status: 200, json: { userId: 'customer_99', mergedFrom: 'telegram:99' } })
    expect((await api('GET', '/users/telegram%3A99', key)).status).toBe(404)

    const memories = await api('GET', '/users/customer_99/memories', key)
    expect(memories.status).toBe(200)
    expect(memories.json).toEqual([
      expect.objectContaining({ agentId, agentName: 'users-merge-agent', endUserId: 'customer_99', fact: 'Prefers delivery after 6 PM' }),
    ])
    expect(JSON.stringify(memories.json)).not.toContain('embedding')
  })

  it('auto-registers canonical users when memory is created directly', async () => {
    const { key, agentId } = await organization('users-auto-register')
    expect((await api('POST', `/agents/${agentId}/memories`, key, {
      endUserId: 'commerce-user-7',
      fact: 'Usually orders medium shirts',
    })).status).toBe(201)
    expect((await api('GET', '/users/commerce-user-7', key)).json.user).toMatchObject({
      id: 'commerce-user-7', memoryCount: 1,
    })
  })
})
