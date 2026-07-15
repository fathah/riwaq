import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { DashboardShell } from '../../components/dashboard-shell'
import { SetupScreen } from '../../components/setup-screen'
import { isDashboardAuthenticated } from '../../lib/auth'
import { getDashboardSetup } from '../../lib/config'
import { getOrganization, getReady } from '../../lib/riwaq'

export const dynamic = 'force-dynamic'

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const setup = getDashboardSetup()
  if (!setup.configured || !(await isDashboardAuthenticated())) redirect('/')

  try {
    const [ready, organization] = await Promise.all([getReady(), getOrganization()])
    return <DashboardShell apiUrl={setup.config.publicApiUrl} organization={organization} ready={ready.ready}>{children}</DashboardShell>
  } catch (cause) {
    return <SetupScreen issues={[cause instanceof Error ? cause.message : 'Unable to connect to the Riwaq API']} apiUrl={setup.config.publicApiUrl} connectionError />
  }
}
