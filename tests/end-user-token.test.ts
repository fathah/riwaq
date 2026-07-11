import { describe, expect, it } from 'vitest'
import { signEndUserToken, verifyEndUserToken } from '../src/lib/end-user-token'

const future = () => Math.floor(Date.now() / 1000) + 60

describe('trusted end-user tokens', () => {
  it('binds a subject to an organization', () => {
    const token = signEndUserToken({ sub: 'user-123', orgId: 'org-a', exp: future() })
    expect(verifyEndUserToken(token, 'org-a').sub).toBe('user-123')
    expect(() => verifyEndUserToken(token, 'org-b')).toThrow('claims')
  })

  it('rejects tampering and expiration', () => {
    const token = signEndUserToken({ sub: 'user-123', orgId: 'org-a', exp: future() })
    expect(() => verifyEndUserToken(`${token}x`, 'org-a')).toThrow()
    const expired = signEndUserToken({ sub: 'user-123', orgId: 'org-a', exp: 1 })
    expect(() => verifyEndUserToken(expired, 'org-a')).toThrow('expired')
  })
})
