export const DASHBOARD_ENV_NAMES = [
  'RIWAQ_API_URL',
  'RIWAQ_API_KEY',
  'RIWAQ_DASHBOARD_TOKEN',
] as const

export type DashboardConfig = {
  apiUrl: string
  publicApiUrl: string
  apiKey: string
  adminToken: string
  accessToken: string
}

export type DashboardSetup =
  | { configured: true; config: DashboardConfig; issues: [] }
  | { configured: false; issues: string[]; apiUrl: string; publicApiUrl: string }

export function getDashboardSetup(): DashboardSetup {
  const rawUrl = process.env.RIWAQ_API_URL?.trim() ?? ''
  const apiKey = process.env.RIWAQ_API_KEY?.trim() ?? ''
  const accessToken = process.env.RIWAQ_DASHBOARD_TOKEN?.trim() ?? ''
  const adminToken = process.env.RIWAQ_ADMIN_TOKEN?.trim() ?? ''
  const rawPublicUrl = process.env.RIWAQ_PUBLIC_API_URL?.trim() ?? ''
  const issues: string[] = []
  let apiUrl = rawUrl

  if (!rawUrl) {
    issues.push('RIWAQ_API_URL is not set')
  } else {
    try {
      const url = new URL(rawUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      url.pathname = url.pathname.replace(/\/$/, '')
      apiUrl = url.toString().replace(/\/$/, '')
    } catch {
      issues.push('RIWAQ_API_URL must be a valid HTTP or HTTPS URL')
    }
  }

  if (!apiKey) issues.push('RIWAQ_API_KEY is not set')
  if (!accessToken) issues.push('RIWAQ_DASHBOARD_TOKEN is not set')
  else if (accessToken.length < 32) issues.push('RIWAQ_DASHBOARD_TOKEN must be at least 32 characters')

  const publicApiUrl = rawPublicUrl || apiUrl || 'http://localhost:3000'
  if (issues.length > 0) return { configured: false, issues, apiUrl, publicApiUrl }
  return { configured: true, config: { apiUrl, publicApiUrl, apiKey, adminToken, accessToken }, issues: [] }
}

export function requireDashboardConfig(): DashboardConfig {
  const setup = getDashboardSetup()
  if (!setup.configured) throw new Error(`Dashboard is not configured: ${setup.issues.join(', ')}`)
  return setup.config
}
