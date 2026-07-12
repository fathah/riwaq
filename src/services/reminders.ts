import { and, desc, eq, inArray, lte } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, organizations, reminderDeliveries, reminders } from '../db/schema'
import { complete, type Usage } from '../lib/llm'
import { resolveLlmConfig } from './llm-config'
import { recordChatUsage } from './usage'
import { decryptSecret } from '../lib/crypto'
import { postSignedWebhook } from '../lib/webhook'
import { env } from '../env'

export type Recurrence = 'daily' | 'weekly' | 'monthly' | 'yearly'
type ReminderRow = typeof reminders.$inferSelect

export type CreateReminderInput = {
  orgId: string
  agentId: string
  endUserId?: string
  title: string
  message?: string
  prompt?: string
  dueAt: Date
  recurrence?: Recurrence | null
  source?: 'api' | 'auto'
}

export async function createReminder(input: CreateReminderInput): Promise<ReminderRow> {
  const [row] = await db
    .insert(reminders)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      endUserId: input.endUserId ?? null,
      title: input.title,
      message: input.message ?? null,
      prompt: input.prompt ?? null,
      dueAt: input.dueAt,
      recurrence: input.recurrence ?? null,
      source: input.source ?? 'api',
      nextFireAt: input.dueAt, // the scheduler works off next_fire_at
    })
    .returning()
  return row!
}

export async function listReminders(agentId: string, status: string | undefined, limit: number, offset: number) {
  const where = status
    ? and(eq(reminders.agentId, agentId), eq(reminders.status, status))
    : eq(reminders.agentId, agentId)
  return db.select().from(reminders).where(where).orderBy(reminders.nextFireAt).limit(limit).offset(offset)
}

export async function getReminder(agentId: string, id: string) {
  const [row] = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.agentId, agentId)))
    .limit(1)
  return row ?? null
}

/** Cancel a reminder (only a live one). Completed/cancelled rows are left as-is. */
export async function cancelReminder(agentId: string, id: string): Promise<boolean> {
  const cancelled = await db
    .update(reminders)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.agentId, agentId), inArray(reminders.status, ['scheduled', 'error'])))
    .returning({ id: reminders.id })
  return cancelled.length > 0
}

export async function listDeliveries(reminderId: string, limit: number, offset: number) {
  return db
    .select()
    .from(reminderDeliveries)
    .where(eq(reminderDeliveries.reminderId, reminderId))
    .orderBy(desc(reminderDeliveries.firedAt))
    .limit(limit)
    .offset(offset)
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Next occurrence strictly after `now`, so a backlog can't cause a fire storm. */
function advance(base: Date, recurrence: Recurrence, now: Date): Date {
  let d = step(base, recurrence)
  while (d.getTime() <= now.getTime()) d = step(d, recurrence)
  return d
}

function step(base: Date, recurrence: Recurrence): Date {
  const d = new Date(base.getTime())
  if (recurrence === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1)
  else if (recurrence === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1)
  return d
}

/**
 * Claim and fire every due reminder. Claiming uses `FOR UPDATE SKIP LOCKED` so
 * multiple API replicas can run the poller without double-firing. Returns how many
 * were fired. Safe to call directly (tests) or from the interval loop.
 */
export async function runReminderTick(): Promise<number> {
  const claimed = await claimDue(env.REMINDER_BATCH)
  for (const r of claimed) {
    try {
      await fireReminder(r)
    } catch (err) {
      console.error('[reminders] fire failed', r.id, err)
      await onFireFailure(r).catch(() => {})
    }
  }
  return claimed.length
}

async function claimDue(limit: number): Promise<ReminderRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.status, 'scheduled'), lte(reminders.nextFireAt, new Date())))
      .orderBy(reminders.nextFireAt)
      .limit(limit)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    return tx
      .update(reminders)
      .set({ status: 'firing', updatedAt: new Date() })
      .where(inArray(reminders.id, due.map((d) => d.id)))
      .returning()
  })
}

async function fireReminder(r: ReminderRow): Promise<void> {
  const message = await composeMessage(r)

  const [org] = await db
    .select({
      url: organizations.webhookUrl,
      secret: organizations.webhookSecret,
      enc: organizations.webhookSecretEncrypted,
    })
    .from(organizations)
    .where(eq(organizations.id, r.orgId))

  if (!org?.url || !org.secret) {
    // Nothing to deliver to — surface it as an error so the operator fixes the
    // webhook rather than reminders silently vanishing.
    await recordDelivery(r.id, 'skipped', null, 'no webhook configured for org', message)
    await db.update(reminders).set({ status: 'error', updatedAt: new Date() }).where(eq(reminders.id, r.id))
    return
  }

  const secret = decryptSecret(org.secret, org.enc)
  const payload = {
    type: 'reminder',
    reminderId: r.id,
    agentId: r.agentId,
    endUserId: r.endUserId,
    title: r.title,
    message,
    dueAt: r.dueAt.toISOString(),
    firedAt: new Date().toISOString(),
    recurrence: r.recurrence,
    source: r.source,
    occurrence: r.fireCount + 1,
  }

  try {
    const res = await postSignedWebhook(org.url, secret, payload)
    if (res.ok) {
      await recordDelivery(r.id, 'ok', res.status, null, message)
      await onFireSuccess(r)
    } else {
      await recordDelivery(r.id, 'failed', res.status, `webhook returned ${res.status}`, message)
      await onFireFailure(r)
    }
  } catch (err) {
    await recordDelivery(r.id, 'failed', null, err instanceof Error ? err.message : 'delivery error', message)
    await onFireFailure(r)
  }
}

async function composeMessage(r: ReminderRow): Promise<string> {
  if (r.message) return r.message
  if (!r.prompt) return r.title
  // Agent-composed: run the agent's model to write the reminder. Best-effort — a
  // compose failure falls back to the title so the reminder still fires.
  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, r.agentId)).limit(1)
    if (!agent) return r.title
    const llm = await resolveLlmConfig(r.orgId, { provider: agent.provider, model: agent.model })
    const system =
      (agent.systemPrompt?.trim() ? agent.systemPrompt.trim() + '\n\n' : '') +
      'Write a short, friendly reminder message to send to the user. Output only the message text — no preamble.'
    const res = await complete({ config: llm, system, messages: [{ role: 'user', content: r.prompt }], maxTokens: 300 })
    await recordChatUsage(r.orgId, res.inputTokens, res.outputTokens).catch(() => {})
    return res.text.trim() || r.title
  } catch (err) {
    console.error('[reminders] compose failed', r.id, err)
    return r.title
  }
}

async function onFireSuccess(r: ReminderRow): Promise<void> {
  const now = new Date()
  if (r.recurrence) {
    await db
      .update(reminders)
      .set({
        status: 'scheduled',
        fireCount: r.fireCount + 1,
        lastFiredAt: now,
        attemptCount: 0,
        nextFireAt: advance(r.nextFireAt, r.recurrence as Recurrence, now),
        updatedAt: now,
      })
      .where(eq(reminders.id, r.id))
  } else {
    await db
      .update(reminders)
      .set({ status: 'completed', fireCount: r.fireCount + 1, lastFiredAt: now, attemptCount: 0, updatedAt: now })
      .where(eq(reminders.id, r.id))
  }
}

async function onFireFailure(r: ReminderRow): Promise<void> {
  const now = new Date()
  const attempts = r.attemptCount + 1
  if (attempts < env.REMINDER_MAX_ATTEMPTS) {
    // Exponential backoff in minutes (2,4,8,…), retried by a later tick.
    const backoffMs = Math.min(2 ** attempts, 240) * 60_000
    await db
      .update(reminders)
      .set({ status: 'scheduled', attemptCount: attempts, nextFireAt: new Date(now.getTime() + backoffMs), updatedAt: now })
      .where(eq(reminders.id, r.id))
  } else {
    await db.update(reminders).set({ status: 'error', attemptCount: attempts, updatedAt: now }).where(eq(reminders.id, r.id))
  }
}

async function recordDelivery(
  reminderId: string,
  status: 'ok' | 'failed' | 'skipped',
  responseCode: number | null,
  error: string | null,
  message: string,
): Promise<void> {
  await db.insert(reminderDeliveries).values({ reminderId, status, responseCode, error, message })
}

// ---------------------------------------------------------------------------
// Interval loop (started at boot on scheduler-enabled nodes)
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined

export function startReminderScheduler(): void {
  if (!env.REMINDER_SCHEDULER_ENABLED || timer) return
  const tick = () => {
    runReminderTick().catch((err) => console.error('[reminders] tick failed', err))
  }
  timer = setInterval(tick, env.REMINDER_POLL_INTERVAL_MS)
  timer.unref() // don't keep the process alive just for the poller
  console.log(`[reminders] scheduler running (every ${env.REMINDER_POLL_INTERVAL_MS}ms)`)
}

export function stopReminderScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

// ---------------------------------------------------------------------------
// Auto-extraction from conversations
// ---------------------------------------------------------------------------

const REMINDER_EXTRACT_SYSTEM = `You extract concrete FUTURE dated commitments a user states, for scheduling reminders.
Return ONLY a JSON array. Each item: { "title": string, "dueDate": "YYYY-MM-DD", "recurrence": "daily"|"weekly"|"monthly"|"yearly"|null }.
Rules: only explicit future dates (renewals, deadlines, appointments, follow-ups). Resolve relative dates against the provided "today". If nothing concrete, return []. No prose.`

export type ExtractedReminder = { title: string; dueAt: Date; recurrence: Recurrence | null }

/** Pure parse + guardrails for the extractor's output — no DB, easy to test. */
export function parseReminderExtractions(raw: string, now: Date, horizonDays: number): ExtractedReminder[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const horizonMs = horizonDays * 86_400_000
  const allowed = new Set(['daily', 'weekly', 'monthly', 'yearly'])
  const out: ExtractedReminder[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    if (!title || typeof o.dueDate !== 'string') continue
    const due = new Date(o.dueDate)
    if (Number.isNaN(due.getTime())) continue
    // Future-only and within the horizon — reject past dates and absurd ones.
    if (due.getTime() <= now.getTime()) continue
    if (due.getTime() - now.getTime() > horizonMs) continue
    const recurrence = typeof o.recurrence === 'string' && allowed.has(o.recurrence) ? (o.recurrence as Recurrence) : null
    out.push({ title: title.slice(0, 200), dueAt: due, recurrence })
  }
  return out
}

/**
 * Detect dated commitments in one turn and create reminders. Guardrailed:
 * future-only + horizon (in the parser), a per-user cap, and de-duplication
 * against existing reminders. Returns LLM usage so the caller can meter it.
 */
export async function extractReminders(opts: {
  orgId: string
  agentId: string
  endUserId: string
  userMessage: string
  llm: Parameters<typeof complete>[0]['config']
  now?: Date
}): Promise<Usage> {
  const now = opts.now ?? new Date()
  const res = await complete({
    config: opts.llm,
    system: REMINDER_EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: `today is ${now.toISOString().slice(0, 10)}\n\n${opts.userMessage}` }],
    maxTokens: 300,
  })
  const usage: Usage = { inputTokens: res.inputTokens, outputTokens: res.outputTokens }

  const candidates = parseReminderExtractions(res.text, now, env.REMINDER_MAX_HORIZON_DAYS)
  if (candidates.length === 0) return usage

  // Per-user cap: don't let extraction balloon a user's reminder list.
  const existing = await db
    .select({ title: reminders.title })
    .from(reminders)
    .where(and(eq(reminders.agentId, opts.agentId), eq(reminders.endUserId, opts.endUserId)))
  if (existing.length >= env.REMINDER_MAX_PER_USER) return usage
  const seen = new Set(existing.map((e) => e.title.toLowerCase()))

  let budget = env.REMINDER_MAX_PER_USER - existing.length
  for (const c of candidates) {
    if (budget <= 0) break
    if (seen.has(c.title.toLowerCase())) continue // dedupe by title
    seen.add(c.title.toLowerCase())
    budget--
    await createReminder({
      orgId: opts.orgId,
      agentId: opts.agentId,
      endUserId: opts.endUserId,
      title: c.title,
      message: `Reminder: ${c.title}`,
      dueAt: c.dueAt,
      recurrence: c.recurrence,
      source: 'auto',
    })
  }
  return usage
}
