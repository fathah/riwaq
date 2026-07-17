import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// Capture webhook deliveries instead of making real HTTP calls (assertPublicUrl
// would block a localhost test server anyway). One mock, controllable per test.
const sent: Array<{ url: string; secret: string; payload: any }> = []
let nextResult: { ok: boolean; status: number } | (() => never) = { ok: true, status: 200 }
vi.mock('../src/lib/webhook', async (orig) => {
  const actual = await orig<typeof import('../src/lib/webhook')>()
  return {
    ...actual, // keep the real signWebhook for the signature test
    postSignedWebhook: vi.fn(async (url: string, secret: string, payload: unknown) => {
      sent.push({ url, secret, payload })
      if (typeof nextResult === 'function') return nextResult()
      return nextResult
    }),
  }
})

const { app } = await import('../src/index')
const { migrate } = await import('../src/db/migrate')
const { db, sql } = await import('../src/db/client')
const schema = await import('../src/db/schema')
const { runReminderTick, parseReminderExtractions } = await import('../src/services/reminders')
const { signWebhook } = await import('../src/lib/webhook')

const { reminders, reminderDeliveries } = schema

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
  return { orgId: org.id, key: org.apiKey, agentId: agent.agent.id }
}

const future = () => new Date(Date.now() + 3600_000).toISOString()
// The API refuses a past dueAt, so to exercise the scheduler we create a future
// reminder then move its next_fire_at into the past (as time would).
async function makeDue(id: string) {
  await db.update(reminders).set({ nextFireAt: new Date(Date.now() - 1000) }).where(eq(reminders.id, id))
}

beforeAll(async () => {
  await migrate()
})
afterAll(async () => {
  await sql.end({ timeout: 5 })
})
beforeEach(() => {
  sent.length = 0
  nextResult = { ok: true, status: 200 }
})

describe('reminders API', () => {
  it('creates, lists, and cancels a reminder', async () => {
    const a = await makeOrgAgent('crud')
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, {
      title: 'Renew SSL cert',
      message: 'Your SSL certificate renews soon.',
      dueAt: future(),
    })
    expect(created.status).toBe(201)
    expect(created.json.status).toBe('scheduled')

    const list = await api('GET', `/agents/${a.agentId}/reminders`, a.key)
    expect(list.json).toHaveLength(1)

    const cancel = await api('DELETE', `/agents/${a.agentId}/reminders/${created.json.id}`, a.key)
    expect(cancel.status).toBe(200)
    const [row] = await db.select().from(reminders).where(eq(reminders.id, created.json.id))
    expect(row!.status).toBe('cancelled')
  })

  it('rejects a past dueAt and a body with neither message nor prompt', async () => {
    const a = await makeOrgAgent('validate')
    const past = new Date(Date.now() - 1000).toISOString()
    expect((await api('POST', `/agents/${a.agentId}/reminders`, a.key, { title: 't', message: 'm', dueAt: past })).status).toBe(400)
    expect((await api('POST', `/agents/${a.agentId}/reminders`, a.key, { title: 't', dueAt: future() })).status).toBe(400)
  })

  it('isolates reminders across orgs', async () => {
    const a = await makeOrgAgent('owner')
    const b = await makeOrgAgent('intruder')
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, { title: 't', message: 'm', dueAt: future() })
    expect((await api('GET', `/agents/${a.agentId}/reminders`, b.key)).status).toBe(404)
    expect((await api('DELETE', `/agents/${a.agentId}/reminders/${created.json.id}`, b.key)).status).toBe(404)
  })
})

// A literal public IP so the SSRF guard passes without needing DNS (delivery
// itself is mocked). 93.184.216.34 is example.com's address — public, not blocked.
const WEBHOOK_URL = 'https://93.184.216.34/riwaq'
async function configureWebhook(key: string) {
  const res = await api('PUT', '/organizations/webhook', key, { url: WEBHOOK_URL })
  return res.json.webhook.secret as string
}

describe('reminder scheduler', () => {
  it('fires a due reminder to the signed webhook and completes a one-off', async () => {
    const a = await makeOrgAgent('fire')
    await configureWebhook(a.key)
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, {
      title: 'Renewal',
      message: 'Time to renew.',
      dueAt: future(),
    })
    await makeDue(created.json.id)

    const fired = await runReminderTick()
    expect(fired).toBeGreaterThanOrEqual(1)

    // Delivered to the configured webhook with the reminder payload.
    const mine = sent.filter((s) => s.payload.reminderId === created.json.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].url).toBe(WEBHOOK_URL)
    expect(mine[0].payload).toMatchObject({ type: 'reminder', title: 'Renewal', message: 'Time to renew.' })

    const [row] = await db.select().from(reminders).where(eq(reminders.id, created.json.id))
    expect(row!.status).toBe('completed') // one-off done
    expect(row!.fireCount).toBe(1)

    const deliveries = await db.select().from(reminderDeliveries).where(eq(reminderDeliveries.reminderId, created.json.id))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.status).toBe('ok')
  })

  it('advances a recurring reminder to the next occurrence', async () => {
    const a = await makeOrgAgent('recurring')
    await configureWebhook(a.key)
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, {
      title: 'Weekly report',
      message: 'Send the weekly report.',
      dueAt: future(),
      recurrence: 'weekly',
    })
    await makeDue(created.json.id)

    await runReminderTick()
    const [row] = await db.select().from(reminders).where(eq(reminders.id, created.json.id))
    expect(row!.status).toBe('scheduled') // still active
    expect(row!.fireCount).toBe(1)
    expect(new Date(row!.nextFireAt).getTime()).toBeGreaterThan(Date.now()) // moved into the future
  })

  it('marks a reminder errored when no webhook is configured', async () => {
    const a = await makeOrgAgent('nohook') // no webhook set
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, { title: 't', message: 'm', dueAt: future() })
    await makeDue(created.json.id)
    await runReminderTick()
    const [row] = await db.select().from(reminders).where(eq(reminders.id, created.json.id))
    expect(row!.status).toBe('error')
    const [delivery] = await db.select().from(reminderDeliveries).where(eq(reminderDeliveries.reminderId, created.json.id))
    expect(delivery!.status).toBe('skipped')
  })

  it('retries (stays scheduled) when the webhook fails, up to the cap', async () => {
    const a = await makeOrgAgent('retry')
    await configureWebhook(a.key)
    const created = await api('POST', `/agents/${a.agentId}/reminders`, a.key, { title: 't', message: 'm', dueAt: future() })
    await makeDue(created.json.id)
    nextResult = { ok: false, status: 500 }

    await runReminderTick()
    const [row] = await db.select().from(reminders).where(eq(reminders.id, created.json.id))
    expect(row!.status).toBe('scheduled') // rescheduled for retry
    expect(row!.attemptCount).toBe(1)
    expect(new Date(row!.nextFireAt).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('webhook signing', () => {
  it('produces a stable HMAC over timestamp + body', () => {
    const sig = signWebhook('secret', '1700000000', '{"a":1}')
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    // Deterministic for the same inputs, different when the body changes.
    expect(signWebhook('secret', '1700000000', '{"a":1}')).toBe(sig)
    expect(signWebhook('secret', '1700000000', '{"a":2}')).not.toBe(sig)
  })
})

describe('reminder auto-extraction (pure parse + guardrails)', () => {
  const now = new Date('2026-07-11T00:00:00Z')
  it('keeps future dated items and drops past / out-of-horizon / malformed ones', () => {
    const raw = `Here you go: [
      {"title":"Renew domain","dueDate":"2027-01-01","recurrence":"yearly"},
      {"title":"Past thing","dueDate":"2020-01-01"},
      {"title":"Too far","dueDate":"2099-01-01"},
      {"title":"","dueDate":"2027-02-02"},
      {"title":"No date"}
    ]`
    const out = parseReminderExtractions(raw, now, 1825)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: 'Renew domain', recurrence: 'yearly' })
    expect(out[0]!.dueAt.toISOString().slice(0, 10)).toBe('2027-01-01')
  })

  it('returns [] for non-array or junk output', () => {
    expect(parseReminderExtractions('no json here', now, 1825)).toEqual([])
    expect(parseReminderExtractions('{"not":"array"}', now, 1825)).toEqual([])
  })
})
