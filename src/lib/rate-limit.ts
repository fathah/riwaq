import { getRedis } from './redis'

// Fixed-window rate limiter. Uses DragonflyDB when available (correct across
// multiple API nodes); otherwise a per-process in-memory window so single-node
// dev deployments still get basic protection. On a Redis error it FAILS OPEN — a
// cache outage must not take down the whole API.

export type RateResult = { allowed: boolean; remaining: number; retryAfter: number }

// --- in-process fallback ---
const buckets = new Map<string, { count: number; resetAt: number }>()

function memoryLimit(key: string, limit: number, windowSeconds: number): RateResult {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowSeconds * 1000 }
    buckets.set(key, b)
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k)
  }
  b.count++
  const retryAfter = Math.ceil((b.resetAt - now) / 1000)
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), retryAfter }
}

export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateResult> {
  const redis = getRedis()
  if (!redis) return memoryLimit(key, limit, windowSeconds)

  try {
    const k = `rl:${key}`
    const n = await redis.incr(k)
    if (n === 1) await redis.expire(k, windowSeconds)
    const ttl = n === 1 ? windowSeconds : await redis.ttl(k)
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfter: ttl > 0 ? ttl : windowSeconds }
  } catch {
    // Redis down → don't block traffic.
    return { allowed: true, remaining: limit, retryAfter: 0 }
  }
}
