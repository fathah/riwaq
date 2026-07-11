import IORedis, { type Redis } from 'ioredis'
import { env } from '../env'

// Optional DragonflyDB / Redis connection. The whole system is designed to run
// WITHOUT it (dev, tests, single-node deployments) — every consumer degrades
// gracefully when this returns null. When REDIS_URL points at a DragonflyDB (or
// Redis) instance, it unlocks durable jobs, caching, and cross-node rate limiting.

export const redisEnabled = env.REDIS_URL !== ''

let client: Redis | null = null

/** Shared connection, or null when Redis is not configured. */
export function getRedis(): Redis | null {
  if (!redisEnabled) return null
  if (!client) {
    client = new IORedis(env.REDIS_URL, {
      // Fail fast instead of hanging a request when Dragonfly is unreachable; callers
      // catch and fall back. BullMQ needs maxRetriesPerRequest: null on its own
      // connection, so it creates a separate one (see lib/queue.ts).
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    })
    client.on('error', (err) => console.error('[redis] connection error:', err.message))
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {})
    client = null
  }
}
