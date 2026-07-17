import { and, eq, ne } from 'drizzle-orm'
import postgres from 'postgres'
import { db, sql } from '../db/client'
import { agentChannels, channelEvents } from '../db/schema'
import { decryptSecret } from '../lib/crypto'
import { enqueueChannelEvent } from '../lib/queue'
import {
  deleteTelegramWebhook,
  getTelegramUpdates,
  TelegramApiError,
} from '../lib/telegram'
import { env } from '../env'
import { ChannelError, recordTelegramUpdate } from './channels'

const POLL_TIMEOUT_SECONDS = 25
const RECONCILE_INTERVAL_MS = 30_000
// Two-key advisory locks avoid colliding with locks used by other subsystems.
const LOCK_NAMESPACE = 1_381_586_257

type Poller = {
  abort: AbortController
  task: Promise<void>
}

let running = false
let reconcileTimer: NodeJS.Timeout | null = null
let reconcileInFlight: Promise<void> | null = null
let lockPool: ReturnType<typeof postgres> | null = null
let lockConnection: Awaited<ReturnType<typeof sql.reserve>> | null = null
const pollers = new Map<string, Poller>()

async function ensureLockConnection(): Promise<void> {
  if (lockConnection) return
  // Keep locks out of the application query pool. This remains safe even when
  // an extremely small local deployment sets DB_POOL_MAX=1.
  lockPool = postgres(env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 0,
    onnotice: () => {},
  })
  lockConnection = await lockPool.reserve()
}

async function closeLockConnection(): Promise<void> {
  try {
    lockConnection?.release()
  } catch {
    // The database may already be gone during forced shutdown.
  }
  lockConnection = null
  await lockPool?.end({ timeout: 1 }).catch(() => {})
  lockPool = null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

async function unlockBot(externalId: string): Promise<void> {
  if (!lockConnection) return
  await lockConnection`
    SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, hashtext(${externalId}))
  `.catch(() => {})
}

async function runChannelPoller(
  channelId: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  let offset: number | undefined
  let failures = 0

  // Upgrades from webhook-based Riwaq installations automatically switch to
  // polling without requiring the operator to touch BotFather or Telegram.
  await deleteTelegramWebhook(token)

  while (running && !signal.aborted) {
    try {
      const updates = await getTelegramUpdates(token, {
        offset,
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
        signal,
      })
      for (const update of updates) {
        if (signal.aborted) return
        const accepted = await recordTelegramUpdate(channelId, update)
        if (accepted.shouldEnqueue) await enqueueChannelEvent({ eventId: accepted.eventId })
        // Telegram considers earlier updates acknowledged on the next getUpdates
        // call. Advance only after durable persistence and queue submission.
        offset = update.update_id + 1
      }
      failures = 0
    } catch (error) {
      if (signal.aborted || !running) return
      if (error instanceof ChannelError && error.status === 404) return
      if (error instanceof TelegramApiError && (error.errorCode === 401 || error.errorCode === 404)) {
        await db
          .update(agentChannels)
          .set({ status: 'error', lastError: error.message.slice(0, 1000), updatedAt: new Date() })
          .where(eq(agentChannels.id, channelId))
          .catch(() => {})
        console.error(`[telegram] channel ${channelId} stopped: ${error.message}`)
        return
      }

      failures += 1
      const backoffMs = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5))
      if (failures === 1 || failures % 10 === 0) {
        const message = error instanceof Error ? error.message : 'polling failed'
        console.warn(`[telegram] channel ${channelId} polling retry in ${backoffMs}ms: ${message}`)
      }
      await sleep(backoffMs, signal)
    }
  }
}

async function startChannel(
  row: { id: string; externalId: string; credential: string; credentialEncrypted: boolean },
): Promise<void> {
  if (!running || pollers.has(row.id) || !lockConnection) return
  const [lock] = await lockConnection<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}, hashtext(${row.externalId})) AS acquired
  `
  if (!lock?.acquired || !running || pollers.has(row.id)) {
    if (lock?.acquired) await unlockBot(row.externalId)
    return
  }

  const abort = new AbortController()
  const token = decryptSecret(row.credential, row.credentialEncrypted)
  const poller: Poller = { abort, task: Promise.resolve() }
  pollers.set(row.id, poller)
  poller.task = runChannelPoller(row.id, token, abort.signal)
    .catch((error) => {
      if (!abort.signal.aborted) console.error(`[telegram] channel ${row.id} poller crashed`, error)
    })
    .finally(async () => {
      if (pollers.get(row.id) === poller) pollers.delete(row.id)
      await unlockBot(row.externalId)
    })
}

async function doReconcile(): Promise<void> {
  if (!running) return
  const rows = await db
    .select({
      id: agentChannels.id,
      externalId: agentChannels.externalId,
      credential: agentChannels.credential,
      credentialEncrypted: agentChannels.credentialEncrypted,
    })
    .from(agentChannels)
    .where(and(eq(agentChannels.provider, 'telegram'), eq(agentChannels.status, 'active')))
  const activeIds = new Set(rows.map((row) => row.id))

  await Promise.all(
    [...pollers.entries()]
      .filter(([channelId]) => !activeIds.has(channelId))
      .map(([, poller]) => {
        poller.abort.abort()
        return poller.task
      }),
  )
  if (rows.length === 0) {
    await closeLockConnection()
    return
  }
  await ensureLockConnection()
  await Promise.all(rows.map((row) => startChannel(row)))
}

/** Discover newly connected/disconnected bots without restarting Riwaq. */
export async function reconcileTelegramPollers(): Promise<void> {
  if (!running) return
  if (!reconcileInFlight) {
    reconcileInFlight = doReconcile().finally(() => {
      reconcileInFlight = null
    })
  }
  await reconcileInFlight
}

export async function stopTelegramChannelPolling(channelId: string): Promise<void> {
  const poller = pollers.get(channelId)
  if (!poller) return
  poller.abort.abort()
  await poller.task
}

async function recoverUnfinishedEvents(): Promise<void> {
  const rows = await db
    .select({ id: channelEvents.id })
    .from(channelEvents)
    .innerJoin(agentChannels, eq(agentChannels.id, channelEvents.channelId))
    .where(and(
      eq(agentChannels.provider, 'telegram'),
      eq(agentChannels.status, 'active'),
      ne(channelEvents.status, 'processed'),
    ))
    .limit(1000)
  await Promise.all(rows.map((row) => enqueueChannelEvent({ eventId: row.id })))
  if (rows.length > 0) console.log(`[telegram] recovered ${rows.length} unfinished update(s)`)
}

/** Start the lightweight in-process Telegram gateway. One reserved Postgres
 * connection owns advisory locks for every bot, so any number of bots costs a
 * constant one lock connection and only one replica polls each token. */
export async function startTelegramPolling(): Promise<void> {
  if (running || !env.TELEGRAM_POLLING_ENABLED) return
  running = true
  await recoverUnfinishedEvents()
  await reconcileTelegramPollers()
  reconcileTimer = setInterval(() => {
    void reconcileTelegramPollers().catch((error) => {
      console.error('[telegram] failed to reconcile polling channels', error)
    })
  }, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref()
  console.log(`[telegram] polling gateway started (${pollers.size} active bot${pollers.size === 1 ? '' : 's'})`)
}

export async function stopTelegramPolling(): Promise<void> {
  if (!running && !lockConnection) return
  running = false
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = null
  // A reconciliation may already be between its active-row query and lock
  // acquisition. Let it observe running=false before snapshotting tasks.
  await reconcileInFlight?.catch(() => {})
  const tasks = [...pollers.values()].map((poller) => {
    poller.abort.abort()
    return poller.task
  })
  await Promise.all(tasks)
  pollers.clear()
  await closeLockConnection()
  console.log('[telegram] polling gateway stopped')
}
