'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense, type ReactNode } from 'react'
import { Toaster } from 'react-hot-toast'
import { logoutAction } from '../app/actions'
import type { Organization } from '../lib/riwaq'
import { Icon, type IconName } from './icons'
import { ToastFeedback } from './toast-feedback'
import { OrganizationSwitcher } from './organization-switcher'
import type { ManagedOrganization } from '../lib/riwaq'

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: '/overview', label: 'Overview', icon: 'grid' },
  { href: '/agents', label: 'Agents', icon: 'bot' },
  { href: '/playground', label: 'Playground', icon: 'playground' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book' },
  { href: '/organizations', label: 'Organizations', icon: 'organization' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
]

type DashboardShellProps = {
  organization: Organization
  ready: boolean
  apiUrl: string
  organizations: ManagedOrganization[]
  children: ReactNode
}

export function DashboardShell({ organization, organizations, ready, apiUrl, children }: DashboardShellProps) {
  const pathname = usePathname()

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Link className="brand-lockup brand-link" href="/overview"><img alt="" aria-hidden="true" className="brand-mark brand-logo" height="38" src="/riwaq-icon.svg" width="38" /><div><strong>Riwaq</strong><span>Console</span></div></Link>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => <Link className={pathname === item.href ? 'nav-active' : ''} href={item.href} key={item.href}><Icon name={item.icon} />{item.label}</Link>)}
        </nav>
        <div className="sidebar-foot">
          <div className="api-state"><span className={ready ? 'status-dot' : 'status-dot status-dot-error'} /><div><strong>API {ready ? 'operational' : 'not ready'}</strong><small>{apiUrl}</small></div></div>
          <form action={logoutAction}><button className="logout-button" type="submit">Lock console</button></form>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="topbar">
          <OrganizationSwitcher activeId={organization.id} organizations={organizations} />
        </header>
        {children}
      </section>

      <Suspense><ToastFeedback /></Suspense>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4200,
          style: { border: '1px solid #d4d4d4', borderRadius: '5px', color: '#0a0a0a', boxShadow: 'none', fontSize: '13px' },
          success: { iconTheme: { primary: '#0a0a0a', secondary: '#fff' } },
          error: { iconTheme: { primary: '#0a0a0a', secondary: '#fff' } },
        }}
      />
    </main>
  )
}
