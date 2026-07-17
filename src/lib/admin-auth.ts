import { timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { env } from '../env'
import type { AppEnv } from '../types'

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function adminTokenFromRequest(c: Context): string {
  const authorization = c.req.header('authorization')
  return authorization?.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : c.req.header('x-admin-token')?.trim() ?? ''
}

export function hasValidAdminToken(c: Context): boolean {
  return !!env.ADMIN_TOKEN && sameSecret(adminTokenFromRequest(c), env.ADMIN_TOKEN)
}

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!hasValidAdminToken(c)) return c.json({ error: 'valid admin token required' }, 401)
  await next()
})
