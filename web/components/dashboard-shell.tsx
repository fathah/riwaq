'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense, type ReactNode } from 'react'
import { Toaster } from 'react-hot-toast'
import { logoutAction } from '../app/actions'
import type { Organization } from '../lib/riwaq'
import { Icon, type IconName } from './icons'
import { ToastFeedback } from './toast-feedback'

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: '/overview', label: 'Overview', icon: 'grid' },
  { href: '/agents', label: 'Agents', icon: 'bot' },
  { href: '/knowledge', label: 'Knowledge', icon: 'book' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
]

type DashboardShellProps = {
  organization: Organization
  ready: boolean
  apiUrl: string
  children: ReactNode
}

export function DashboardShell({ organization, ready, apiUrl, children }: DashboardShellProps) {
  const pathname = usePathname()

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Link className="brand-lockup brand-link" href="/overview"><span className="brand-mark">R</span><div><strong>Riwaq</strong><span>Console</span></div></Link>
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
          <div><span className="eyebrow">Organization workspace</span><h1>{organization.name}</h1></div>
          <div className="org-avatar">{organization.name.slice(0, 2).toUpperCase()}</div>
        </header>
        <nav aria-label="Console sections" className="route-tabs" role="tablist">
          {navigation.map((item) => <Link aria-selected={pathname === item.href} className={pathname === item.href ? 'tab-active' : ''} href={item.href} key={item.href} role="tab">{item.label}</Link>)}
        </nav>
        {children}
      </section>

      <Suspense><ToastFeedback /></Suspense>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4200,
          style: { border: '1px solid #e5e9e6', borderRadius: '12px', color: '#17231d', boxShadow: '0 18px 45px rgba(30,48,39,.14)', fontSize: '13px' },
          success: { iconTheme: { primary: '#0f8b62', secondary: '#fff' } },
          error: { iconTheme: { primary: '#ba3d45', secondary: '#fff' } },
        }}
      />
    </main>
  )
}
