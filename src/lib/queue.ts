import { Queue, Worker, type Job } from 'bullmq'
import { redisEnabled } from './redis'
import { env } from '../env'
import { performIngest, markIngestFailed, ingestText } from '../services/ingest'
import { processLearn, type LearnPayload } from '../services/learn'

// Durable background jobs on DragonflyDB via BullMQ. When Redis is configured,
// ingestion + learning are enqueued and survive an API restart (with retries for
// idempotent ingestion). When it is NOT configured, both fall back to the original
// in-process fire-and-forget path, so nothing is required to run the app.

export type IngestPayload = { documentId: string; knowledgeBaseId: string; text: string }

const INGEST = 'ingest'
const LEARN = 'learn'

// Give BullMQ a connection-options object (parsed from REDIS_URL) rather than an
// ioredis instance — BullMQ manages its own connection (and the required
// maxRetriesPerRequest:null) internally, and this avoids a dual-ioredis type clash.
function bullConnection() {
  const u = new URL(env.REDIS_URL)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  }
}

let ingestQueue: Queue | null = null
let learnQueue: Queue | null = null
let workers: Worker[] = []

function getIngestQueue(): Queue {
  if (!ingestQueue) ingestQueue = new Queue(INGEST, { connection: bullConnection() })
  return ingestQueue
}
function getLearnQueue(): Queue {
  if (!learnQueue) learnQueue = new Queue(LEARN, { connection: bullConnection() })
  return learnQueue
}

/** Enqueue ingestion (durable) or run it in-process when no queue is configured. */
export async function enqueueIngest(p: IngestPayload): Promise<void> {
  if (!redisEnabled) {
    void ingestText(p.documentId, p.knowledgeBaseId, p.text) // fire-and-forget fallback
    return
  }
  await getIngestQueue().add(INGEST, p, {
    attempts: 3, // ingestion is idempotent (delete+reinsert), so retries are safe
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: 500,
  })
}

/** Enqueue learning (durable) or run it in-process when no queue is configured. */
export async function enqueueLearn(p: LearnPayload): Promise<void> {
  if (!redisEnabled) {
    void processLearn(p)
    return
  }
  await getLearnQueue().add(LEARN, p, {
    jobId: `learn-${p.userMessageId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: 500,
  })
}

/** Start BullMQ workers (no-op without Redis). Call once at boot. */
export function startWorkers(): void {
  if (!redisEnabled) return

  const ingestWorker = new Worker(
    INGEST,
    async (job: Job) => {
      const d = job.data as IngestPayload
      await performIngest(d.documentId, d.knowledgeBaseId, d.text)
    },
    { connection: bullConnection() },
  )
  ingestWorker.on('failed', async (job, err) => {
    // Only give up (mark the document errored) once retries are exhausted.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const d = job.data as IngestPayload
      console.error(`[queue] ingest ${d.documentId} failed permanently:`, err?.message)
      await markIngestFailed(d.documentId).catch(() => {})
    }
  })

  const learnWorker = new Worker(LEARN, async (job: Job) => processLearn(job.data as LearnPayload), {
    connection: bullConnection(),
  })
  learnWorker.on('failed', (job, err) => console.error('[queue] learn failed:', err?.message, job?.id))

  workers = [ingestWorker, learnWorker]
  console.log('[queue] durable workers started (ingest, learn)')
}

export async function closeQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close())).catch(() => {})
  await ingestQueue?.close().catch(() => {})
  await learnQueue?.close().catch(() => {})
}

export async function queueMetrics(): Promise<Record<string, number>> {
  if (!redisEnabled) return { enabled: 0 }
  const [ingest, learn] = await Promise.all([getIngestQueue().getJobCounts(), getLearnQueue().getJobCounts()])
  return {
    enabled: 1,
    ingest_waiting: ingest.waiting ?? 0,
    ingest_active: ingest.active ?? 0,
    ingest_failed: ingest.failed ?? 0,
    learn_waiting: learn.waiting ?? 0,
    learn_active: learn.active ?? 0,
    learn_failed: learn.failed ?? 0,
  }
}
