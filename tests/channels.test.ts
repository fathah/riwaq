import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { agentChannels, channelEvents } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { splitTelegramText } from '../src/lib/telegram'
import { acceptTelegramUpdate } from '../src/services/channels'

async function api(method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  return { status: response.status, json: await response.json().catch(() => null) as any }
}

const token = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
let key: string
let agentId: string
let channelId: string
let webhookSecret: string
const telegramCalls: Array<{ method: string; body: Record<string, any> }> = []

beforeAll(async () => {
  await migrate()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = url.split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    telegramCalls.push({ method, body })
    if (method === 'getMe') {
      return Response.json({ ok: true, result: { id: 9001, is_bot: true, first_name: 'Riwaq Test', username: 'riwaq_test_bot' } })
    }
    return Response.json({ ok: true, result: true })
  }))

  const org = (await api('POST', '/organizations', 'test-admin-token', { name: 'channels-org' })).json
  key = org.apiKey
  agentId = (await api('POST', '/agents', key, { name: 'telegram-agent' })).json.agent.id
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await sql.end({ timeout: 5 })
})

describe('Telegram channel management', () => {
  it('verifies the bot, registers a secret webhook, and never returns credentials', async () => {
    const response = await api('POST', `/agents/${agentId}/channels/telegram`, key, { token })
    expect(response.status).toBe(201)
    expect(response.json).toMatchObject({ agentId, provider: 'telegram', externalUsername: 'riwaq_test_bot', status: 'active' })
    expect(JSON.stringify(response.json)).not.toContain(token)
    expect(JSON.stringify(response.json)).not.toContain('credential')
    channelId = response.json.id

    const setWebhook = telegramCalls.find((call) => call.method === 'setWebhook')
    expect(setWebhook?.body.url).toBe(`https://riwaq.test/webhooks/telegram/${channelId}`)
    expect(setWebhook?.body.allowed_updates).toEqual(['message'])
    webhookSecret = setWebhook?.body.secret_token
    expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const listed = await api('GET', '/channels', key)
    expect(listed.status).toBe(200)
    expect(listed.json).toEqual([expect.objectContaining({ id: channelId, agentId })])
    expect(JSON.stringify(listed.json)).not.toContain(token)
    const [stored] = await db
      .select({ credential: agentChannels.credential, encrypted: agentChannels.credentialEncrypted })
      .from(agentChannels)
      .where(eq(agentChannels.id, channelId))
    expect(stored?.encrypted).toBe(true)
    expect(stored?.credential).not.toContain(token)
  })

  it('rejects an invalid secret without revealing the connection', async () => {
    const response = await api('POST', `/webhooks/telegram/${channelId}`, undefined, { update_id: 100 }, {
      'x-telegram-bot-api-secret-token': 'wrong-secret',
    })
    expect(response.status).toBe(404)
  })

  it('allows a provider retry to recover an event that was stored but not queued', async () => {
    const first = await acceptTelegramUpdate(channelId, webhookSecret, { update_id: 102 })
    const retry = await acceptTelegramUpdate(channelId, webhookSecret, { update_id: 102 })
    expect(retry).toEqual({ eventId: first.eventId, shouldEnqueue: true })
    await db.delete(channelEvents).where(eq(channelEvents.id, first.eventId))
  })

  it('deduplicates retried Telegram updates before queue processing', async () => {
    const headers = { 'x-telegram-bot-api-secret-token': webhookSecret }
    expect((await api('POST', `/webhooks/telegram/${channelId}`, undefined, { update_id: 101 }, headers)).status).toBe(200)
    expect((await api('POST', `/webhooks/telegram/${channelId}`, undefined, { update_id: 101 }, headers)).status).toBe(200)

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [event] = await db
        .select({ status: channelEvents.status })
        .from(channelEvents)
        .where(eq(channelEvents.channelId, channelId))
      if (event?.status === 'processed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const events = await db.select().from(channelEvents).where(eq(channelEvents.channelId, channelId))
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('processed')
  })

  it('removes the Telegram webhook and local connection', async () => {
    const response = await api('DELETE', `/agents/${agentId}/channels/${channelId}`, key)
    expect(response).toEqual({ status: 200, json: { ok: true, webhookRemoved: true } })
    expect(telegramCalls.some((call) => call.method === 'deleteWebhook')).toBe(true)
    expect(await db.select().from(agentChannels).where(eq(agentChannels.id, channelId))).toHaveLength(0)
  })
})

describe('Telegram answer framing', () => {
  it('splits long answers within Telegram limits without losing content', () => {
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
    const parts = splitTelegramText(text)
    expect(parts.length).toBe(2)
    expect(parts.every((part) => Array.from(part).length <= 4000)).toBe(true)
    expect(parts.join('\n')).toBe(text)
  })
})
