import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { getDashboardSetup } from './config'

const COOKIE_NAME = 'riwaq_dashboard_session'
const ORGANIZATION_COOKIE_NAME = 'riwaq_dashboard_organization'
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
  ;(await cookies()).delete(ORGANIZATION_COOKIE_NAME)
}

export async function requireDashboardSession(): Promise<void> {
  if (!(await isDashboardAuthenticated())) throw new Error('Dashboard authentication required')
}

function organizationSignature(organizationId: string, token: string): string {
  return createHmac('sha256', token).update(`riwaq-dashboard-organization:${organizationId}`).digest('base64url')
}

export async function getSelectedOrganizationId(): Promise<string | null> {
  const setup = getDashboardSetup()
  if (!setup.configured) return null
  const value = (await cookies()).get(ORGANIZATION_COOKIE_NAME)?.value ?? ''
  const separator = value.lastIndexOf('.')
  if (separator < 1) return null
  const organizationId = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  return sameValue(signature, organizationSignature(organizationId, setup.config.accessToken)) ? organizationId : null
}

export async function setSelectedOrganizationId(organizationId: string): Promise<void> {
  const setup = getDashboardSetup()
  if (!setup.configured) throw new Error('Dashboard is not configured')
  ;(await cookies()).set(
    ORGANIZATION_COOKIE_NAME,
    `${organizationId}.${organizationSignature(organizationId, setup.config.accessToken)}`,
    { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 12 },
  )
}
