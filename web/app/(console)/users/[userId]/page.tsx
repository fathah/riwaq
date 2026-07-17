import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DeleteAgentMemoryModal, EditAgentMemoryModal } from '../../../../components/agent-memory-modals'
import { AddUserIdentityModal, AddUserMemoryModal, DisconnectIdentityModal, EditUserModal } from '../../../../components/user-modals'
import { getAgents, getUser, getUserMemories, RiwaqApiError } from '../../../../lib/riwaq'
import type { Agent, EndUserDetail, UserMemory } from '../../../../lib/riwaq'

function date(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId: encodedUserId } = await params
  // Next keeps encoded dynamic path segments intact. Decode once before the API
  // client applies its own URL encoding (important for legacy `telegram:...` IDs).
  const userId = decodeURIComponent(encodedUserId)
  let detail: EndUserDetail
  let memories: UserMemory[]
  let agents: Agent[]
  try {
    detail = await getUser(userId)
    memories = await getUserMemories(userId)
    agents = await getAgents()
  } catch (error) {
    if (error instanceof RiwaqApiError && error.status === 404) notFound()
    throw error
  }
  const { user, identities } = detail
  const path = `/users/${encodeURIComponent(user.id)}`
  const memoryGroups = Array.from(memories.reduce((groups, memory) => {
    const group = groups.get(memory.agentId) ?? { agentName: memory.agentName, rows: [] as UserMemory[] }
    group.rows.push(memory)
    groups.set(memory.agentId, group)
    return groups
  }, new Map<string, { agentName: string; rows: UserMemory[] }>()))

  return (
    <div className="page-content">
      <Link className="back-link" href="/users">← Users</Link>
      <header className="page-header">
        <div><span className="eyebrow">Organization user</span><h2>{user.displayName || user.id}</h2><p><code>{user.id}</code> is the canonical ID shared by every connected channel and integration.</p></div>
        <EditUserModal user={user} />
      </header>

      <section className="user-summary-grid">
        <article className="agent-detail-card">
          <span className="eyebrow">Identity record</span>
          <dl>
            <div><dt>Canonical ID</dt><dd><code>{user.id}</code></dd></div>
            <div><dt>Platform identities</dt><dd>{user.identityCount}</dd></div>
            <div><dt>Agent memories</dt><dd>{user.memoryCount}</dd></div>
            <div><dt>Created</dt><dd>{date(user.createdAt)}</dd></div>
          </dl>
        </article>
        <article className="identity-card">
          <header className="section-action-header"><div><span className="eyebrow">Cross-channel resolution</span><h3>Connected identities</h3></div><AddUserIdentityModal user={user} /></header>
          {identities.length === 0 ? <div className="compact-empty">No platform identities connected.</div> : <div className="identity-list">{identities.map((identity) => (
            <div className="identity-row" key={identity.id}>
              <div><strong>{identity.provider}</strong><span>{identity.namespace} · <code>{identity.externalUserId}</code></span></div>
              <DisconnectIdentityModal userId={user.id} identity={identity} />
            </div>
          ))}</div>}
        </article>
      </section>

      <section className="agent-memory-section">
        <header className="section-action-header"><div><span className="eyebrow">Durable personalization</span><h3>User memory</h3><p>All memories for this user, grouped by the agent that can recall them.</p></div>{agents.length ? <AddUserMemoryModal userId={user.id} agents={agents} /> : null}</header>
        {memories.length === 0 ? <div className="list-card"><div className="empty-state"><span>◇</span><h3>No memories for this user</h3><p>Agents can learn facts during conversations, or you can add one manually.</p></div></div> : memoryGroups.map(([agentId, group]) => (
          <article className="memory-scope" key={agentId}>
            <header><div><Link href={`/agents/${agentId}`}><strong>{group.agentName}</strong></Link><span>{group.rows.length} {group.rows.length === 1 ? 'fact' : 'facts'}</span></div></header>
            <div className="list-card">{group.rows.map((memory) => (
              <div className="row-item memory-row" key={memory.id}>
                <span className="row-icon">M</span>
                <div className="row-copy"><strong>{memory.fact}</strong><span>Updated {date(memory.updatedAt)}</span></div>
                <div className="memory-row-actions"><EditAgentMemoryModal agentId={agentId} memory={memory} returnPath={path} /><DeleteAgentMemoryModal agentId={agentId} memory={memory} returnPath={path} /></div>
              </div>
            ))}</div>
          </article>
        ))}
      </section>
    </div>
  )
}
