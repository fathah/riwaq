import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { migrate } from '../src/db/migrate'
import { db, sql } from '../src/db/client'
import { agentChannels, channelEvents } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import {
  renderTelegramMarkdown,
  sendTelegramMessage,
  startTelegramTyping,
} from '../src/lib/telegram'
import { recordTelegramUpdate } from '../src/services/channels'
import { startTelegramPolling, stopTelegramPolling } from '../src/services/telegram-polling'

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
const telegramCalls: Array<{ method: string; body: Record<string, any> }> = []
const pendingUpdates: Array<Record<string, unknown>> = []
let rejectNextFormattedMessage = false

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
    if (method === 'getUpdates') {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ ok: true, result: pendingUpdates.splice(0) })
    }
    if (method === 'sendMessage' && body.parse_mode === 'HTML' && rejectNextFormattedMessage) {
      rejectNextFormattedMessage = false
      return Response.json(
        { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
        { status: 400 },
      )
    }
    return Response.json({ ok: true, result: true })
  }))

  const org = (await api('POST', '/organizations', 'test-admin-token', { name: 'channels-org' })).json
  key = org.apiKey
  agentId = (await api('POST', '/agents', key, { name: 'telegram-agent' })).json.agent.id
})

afterAll(async () => {
  await stopTelegramPolling()
  vi.unstubAllGlobals()
  await sql.end({ timeout: 5 })
})

describe('Telegram channel management', () => {
  it('verifies the bot, clears stale webhooks, and never returns credentials', async () => {
    const response = await api('POST', `/agents/${agentId}/channels/telegram`, key, { token })
    expect(response.status).toBe(201)
    expect(response.json).toMatchObject({ agentId, provider: 'telegram', externalUsername: 'riwaq_test_bot', status: 'active' })
    expect(JSON.stringify(response.json)).not.toContain(token)
    expect(JSON.stringify(response.json)).not.toContain('credential')
    channelId = response.json.id

    expect(telegramCalls.some((call) => call.method === 'deleteWebhook')).toBe(true)
    expect(telegramCalls.some((call) => call.method === 'setWebhook')).toBe(false)

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

  it('receives messages through outbound polling and runs the canonical channel worker', async () => {
    pendingUpdates.push({
      update_id: 101,
      message: {
        message_id: 501,
        text: '/help',
        from: { id: 42, is_bot: false, first_name: 'Local User' },
        chat: { id: 42, type: 'private' },
      },
    })
    await startTelegramPolling()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [event] = await db
        .select({ status: channelEvents.status })
        .from(channelEvents)
        .where(eq(channelEvents.providerEventId, '101'))
      if (event?.status === 'processed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await stopTelegramPolling()

    const [event] = await db.select().from(channelEvents).where(eq(channelEvents.providerEventId, '101'))
    expect(event?.status).toBe('processed')
    expect(event?.responseText).toContain('powered by Riwaq')
    expect(telegramCalls.some((call) => call.method === 'getUpdates')).toBe(true)
    expect(telegramCalls.some((call) => call.method === 'sendMessage' && call.body.parse_mode === 'HTML')).toBe(true)
  })

  it('allows a repeated poll to recover an event that was stored but not queued', async () => {
    const first = await recordTelegramUpdate(channelId, { update_id: 102 })
    const retry = await recordTelegramUpdate(channelId, { update_id: 102 })
    expect(retry).toEqual({ eventId: first.eventId, shouldEnqueue: true })
    await db.delete(channelEvents).where(eq(channelEvents.id, first.eventId))
  })

  it('deduplicates Telegram update IDs', async () => {
    const first = await recordTelegramUpdate(channelId, { update_id: 103 })
    const retry = await recordTelegramUpdate(channelId, { update_id: 103 })
    expect(retry.eventId).toBe(first.eventId)
    const events = await db.select().from(channelEvents).where(eq(channelEvents.providerEventId, '103'))
    expect(events).toHaveLength(1)
    await db.delete(channelEvents).where(eq(channelEvents.id, first.eventId))
  })

  it('stops polling and removes the local connection', async () => {
    const response = await api('DELETE', `/agents/${agentId}/channels/${channelId}`, key)
    expect(response).toEqual({ status: 200, json: { ok: true } })
    expect(telegramCalls.some((call) => call.method === 'deleteWebhook')).toBe(true)
    expect(await db.select().from(agentChannels).where(eq(agentChannels.id, channelId))).toHaveLength(0)
  })
})

describe('Telegram answer framing', () => {
  it('refreshes the typing action until processing stops', async () => {
    const before = telegramCalls.filter((call) => call.method === 'sendChatAction').length
    const typing = startTelegramTyping(token, { chatId: '42', refreshMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 35))
    await typing.stop()
    const afterStop = telegramCalls.filter((call) => call.method === 'sendChatAction').length
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(afterStop - before).toBeGreaterThanOrEqual(2)
    expect(telegramCalls.filter((call) => call.method === 'sendChatAction')).toHaveLength(afterStop)
  })

  it('splits long answers within Telegram limits without losing content', () => {
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
    const parts = renderTelegramMarkdown(text)
    expect(parts.length).toBe(2)
    expect(parts.every((part) => Array.from(part.plainText).length <= 3900)).toBe(true)
    expect(parts.map((part) => part.plainText).join('\n')).toBe(text)
  })

  it('renders canonical Markdown as safe Telegram HTML', () => {
    const [part] = renderTelegramMarkdown([
      '## Tech Stack',
      '',
      '- **Web:** Next.js',
      '- Use `<unsafe>` and [docs](https://example.com)',
      '',
      '```ts',
      'const value = a < b',
      '```',
    ].join('\n'))

    expect(part?.html).toContain('<b>Tech Stack</b>')
    expect(part?.html).toContain('• <b>Web:</b> Next.js')
    expect(part?.html).toContain('<code>&lt;unsafe&gt;</code>')
    expect(part?.html).toContain('<a href="https://example.com">docs</a>')
    expect(part?.html).toContain('<pre>const value = a &lt; b</pre>')
    expect(part?.plainText).not.toContain('**')
    expect(part?.plainText).not.toContain('##')
  })

  it('retries as plain text when Telegram rejects formatted HTML', async () => {
    const before = telegramCalls.length
    rejectNextFormattedMessage = true
    await sendTelegramMessage(token, {
      chatId: '42',
      text: '<b>Hello</b>',
      parseMode: 'HTML',
      fallbackText: 'Hello',
    })
    const calls = telegramCalls.slice(before).filter((call) => call.method === 'sendMessage')

    expect(calls).toHaveLength(2)
    expect(calls[0]?.body).toMatchObject({ text: '<b>Hello</b>', parse_mode: 'HTML' })
    expect(calls[1]?.body).toMatchObject({ text: 'Hello' })
    expect(calls[1]?.body).not.toHaveProperty('parse_mode')
  })
})
