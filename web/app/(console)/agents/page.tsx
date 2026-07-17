import Link from 'next/link'
import { CreateAgentModal } from '../../../components/action-modals'
import { getAgents } from '../../../lib/riwaq'

function date(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

export default async function AgentsPage() {
  const agents = await getAgents()
  return (
    <div className="page-content">
      <header className="page-header"><div><span className="eyebrow">RAG + memory</span><h2>Agents</h2><p>Create assistants with their own prompts, models, memory, and private knowledge.</p></div><CreateAgentModal /></header>
      <section className="list-card page-card">
        {agents.length === 0 ? <div className="empty-state"><span>✦</span><h3>No agents yet</h3><p>Create one to receive a private knowledge base automatically.</p></div> : agents.map((agent) => (
          <Link className="row-item row-link" href={`/agents/${agent.id}`} key={agent.id}>
            <span className="row-icon">{agent.name.slice(0, 1).toUpperCase()}</span>
            <div className="row-copy"><strong>{agent.name}</strong><span>{agent.provider || 'Inherited provider'} · {agent.model || 'Default model'}</span></div>
            <div className="row-meta"><span>{date(agent.createdAt)}</span><span className="row-open">Open agent →</span></div>
          </Link>
        ))}
      </section>
    </div>
  )
}
