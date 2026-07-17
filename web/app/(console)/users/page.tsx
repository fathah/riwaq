import Link from 'next/link'
import { ConnectUserModal } from '../../../components/user-modals'
import { getUsers } from '../../../lib/riwaq'

function date(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

export default async function UsersPage() {
  const users = await getUsers()
  return (
    <div className="page-content">
      <header className="page-header">
        <div><span className="eyebrow">Organization identity</span><h2>Users</h2><p>Connect customers from your database to Telegram, WhatsApp, commerce platforms, and durable agent memory.</p></div>
        <ConnectUserModal />
      </header>
      <section className="list-card page-card">
        {users.length === 0 ? <div className="empty-state"><span>◎</span><h3>No users yet</h3><p>Users appear automatically from conversations, or connect one using your existing customer ID.</p></div> : users.map((user) => (
          <Link className="row-item row-link" href={`/users/${encodeURIComponent(user.id)}`} key={user.id}>
            <span className="row-icon">{(user.displayName || user.id).slice(0, 1).toUpperCase()}</span>
            <div className="row-copy"><strong>{user.displayName || user.id}</strong><span><code>{user.id}</code> · {user.identityCount} {user.identityCount === 1 ? 'identity' : 'identities'} · {user.memoryCount} {user.memoryCount === 1 ? 'memory' : 'memories'}</span></div>
            <div className="row-meta"><span>Updated {date(user.updatedAt)}</span><span className="row-open">Open user →</span></div>
          </Link>
        ))}
      </section>
      {users.length === 200 ? <p className="memory-limit-note">Showing the 200 most recently updated users.</p> : null}
    </div>
  )
}
