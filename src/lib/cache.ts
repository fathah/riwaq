import { getRedis } from './redis'
import { env } from '../env'

// Thin best-effort cache over DragonflyDB. Every operation is safe to call when
// Redis is absent or unreachable: reads miss, writes no-op. Caching must never be
// load-bearing for correctness — only for latency/DB-load reduction.

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = env.CACHE_TTL_SECONDS): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch {
    /* best-effort */
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const redis = getRedis()
  if (!redis || keys.length === 0) return
  try {
    await redis.del(...keys)
  } catch {
    /* best-effort */
  }
}
