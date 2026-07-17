import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AgentChannelModal } from '../../../../components/agent-channel-modal'
import { getAgent, getAgentChannels, RiwaqApiError } from '../../../../lib/riwaq'
import type { AgentChannel, AgentDetail } from '../../../../lib/riwaq'

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params
  let agent: AgentDetail
  let channels: AgentChannel[]

  try {
    ;[agent, channels] = await Promise.all([getAgent(agentId), getAgentChannels(agentId)])
  } catch (error) {
    if (error instanceof RiwaqApiError && error.status === 404) notFound()
    throw error
  }

  const telegram = channels.find((channel) => channel.provider === 'telegram')

  return (
    <div className="page-content">
      <Link className="back-link" href="/agents">← Agents</Link>
      <header className="page-header">
        <div>
          <span className="eyebrow">Agent workspace</span>
          <h2>{agent.name}</h2>
          <p>Manage this agent’s model, knowledge, and messaging connections.</p>
        </div>
      </header>

      <section className="agent-detail-grid">
        <article className="agent-detail-card">
          <span className="eyebrow">Configuration</span>
          <dl>
            <div><dt>Provider</dt><dd>{agent.effectiveLlm.provider}</dd></div>
            <div><dt>Model</dt><dd>{agent.effectiveLlm.model}</dd></div>
            <div><dt>Knowledge bases</dt><dd>{agent.knowledgeBases.length}</dd></div>
            <div><dt>Agent ID</dt><dd><code>{agent.id.slice(0, 8)}</code></dd></div>
          </dl>
        </article>

        <article className="agent-detail-card agent-channel-card">
          <div>
            <span className="eyebrow">Messaging</span>
            <h3>Telegram</h3>
            <p>{telegram ? `${telegram.externalUsername ? `@${telegram.externalUsername}` : telegram.displayName} is connected to this agent.` : 'Connect a Telegram bot so messages use this agent’s prompt, knowledge, and memory.'}</p>
          </div>
          <AgentChannelModal agent={agent} channel={telegram} />
        </article>
      </section>

      <section className="agent-knowledge-section">
        <header><span className="eyebrow">Available context</span><h3>Knowledge</h3></header>
        <div className="list-card">
          {agent.knowledgeBases.length === 0 ? (
            <div className="empty-state"><h3>No knowledge connected</h3><p>Add knowledge from the Knowledge page.</p></div>
          ) : agent.knowledgeBases.map((knowledgeBase) => (
            <Link className="row-item row-link" href={`/knowledge/${knowledgeBase.id}`} key={knowledgeBase.id}>
              <span className="row-icon">K</span>
              <div className="row-copy"><strong>{knowledgeBase.name}</strong><span>{knowledgeBase.isDefault ? 'Private agent knowledge' : 'Shared organization knowledge'}</span></div>
              <span className="row-open">Open →</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
