import { describe, it, expect } from 'vitest'
import { checkRateLimit } from '../src/lib/rate-limit'

// No REDIS_URL in tests → exercises the in-process fixed-window fallback.
describe('rate limiter (in-process fallback)', () => {
  it('allows up to the limit, then blocks within the window', async () => {
    const key = `unit-${Math.random()}`
    const limit = 3

    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit(key, limit, 60)
      expect(r.allowed).toBe(true)
    }
    const blocked = await checkRateLimit(key, limit, 60)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  it('tracks distinct keys independently', async () => {
    const a = await checkRateLimit(`a-${Math.random()}`, 1, 60)
    const b = await checkRateLimit(`b-${Math.random()}`, 1, 60)
    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)
  })

  it('resets after the window elapses', async () => {
    const key = `win-${Math.random()}`
    expect((await checkRateLimit(key, 1, 1)).allowed).toBe(true)
    expect((await checkRateLimit(key, 1, 1)).allowed).toBe(false)
    await new Promise((r) => setTimeout(r, 1100))
    expect((await checkRateLimit(key, 1, 1)).allowed).toBe(true)
  })
})
