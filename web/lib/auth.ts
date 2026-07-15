import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { getDashboardSetup } from './config'

const COOKIE_NAME = 'riwaq_dashboard_session'
const SESSION_MESSAGE = 'riwaq-dashboard-authenticated-v1'

function sessionValue(token: string): string {
  return createHmac('sha256', token).update(SESSION_MESSAGE).digest('base64url')
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function isDashboardAuthenticated(): Promise<boolean> {
  const setup = getDashboardSetup()
  if (!setup.configured) return false
  const current = (await cookies()).get(COOKIE_NAME)?.value ?? ''
  return sameValue(current, sessionValue(setup.config.accessToken))
}

export async function createDashboardSession(submittedToken: string): Promise<boolean> {
  const setup = getDashboardSetup()
  if (!setup.configured || !sameValue(submittedToken, setup.config.accessToken)) return false

  ;(await cookies()).set(COOKIE_NAME, sessionValue(setup.config.accessToken), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return true
}

export async function clearDashboardSession(): Promise<void> {
  ;(await cookies()).delete(COOKIE_NAME)
}

export async function requireDashboardSession(): Promise<void> {
  if (!(await isDashboardAuthenticated())) throw new Error('Dashboard authentication required')
}
