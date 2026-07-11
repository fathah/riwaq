import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../env'

export type EndUserClaims = { sub: string; orgId: string; exp: number }

function signature(payload: string): Buffer {
  return createHmac('sha256', Buffer.from(env.END_USER_SIGNING_SECRET, 'base64')).update(payload).digest()
}

/** Helper for trusted organization backends; Riwaq itself does not issue user tokens. */
export function signEndUserToken(claims: EndUserClaims): string {
  if (!env.END_USER_SIGNING_SECRET) throw new Error('END_USER_SIGNING_SECRET is not configured')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${signature(payload).toString('base64url')}`
}

export function verifyEndUserToken(token: string, expectedOrgId: string): EndUserClaims {
  if (!env.END_USER_SIGNING_SECRET) throw new Error('trusted end-user identity is not configured')
  const [payload, supplied, extra] = token.split('.')
  if (!payload || !supplied || extra) throw new Error('malformed end-user token')
  const actual = signature(payload)
  const candidate = Buffer.from(supplied, 'base64url')
  if (candidate.length !== actual.length || !timingSafeEqual(candidate, actual)) throw new Error('invalid end-user token')
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('malformed end-user token')
  }
  const c = claims as Partial<EndUserClaims>
  if (typeof c.sub !== 'string' || !c.sub || c.orgId !== expectedOrgId || typeof c.exp !== 'number') {
    throw new Error('invalid end-user token claims')
  }
  if (c.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired end-user token')
  return c as EndUserClaims
}
