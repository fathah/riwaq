import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AgentChannelModal } from '../../../../components/agent-channel-modal'
import { EditAgentInstructionsModal } from '../../../../components/action-modals'
import { AddAgentMemoryModal, DeleteAgentMemoryModal, EditAgentMemoryModal, ForgetAgentUserModal } from '../../../../components/agent-memory-modals'
import { getAgent, getAgentChannels, getAgentMemories, RiwaqApiError } from '../../../../lib/riwaq'
import type { AgentChannel, AgentDetail, AgentMemory } from '../../../../lib/riwaq'

function memoryScope(endUserId: string | null): string {
  if (!endUserId) return 'Agent-wide'
  if (endUserId.startsWith('telegram:')) return `Telegram user ${endUserId.slice('telegram:'.length)}`
  return endUserId
}

function memoryDate(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params
  let agent: AgentDetail
  let channels: AgentChannel[]
  let memories: AgentMemory[]

  try {
    // Keep management reads lightweight under small self-hosted concurrency
    // limits. The dashboard shell also performs its own authenticated reads.
    agent = await getAgent(agentId)
    channels = await getAgentChannels(agentId)
    memories = await getAgentMemories(agentId)
  } catch (error) {
    if (error instanceof RiwaqApiError && error.status === 404) notFound()
    throw error
  }

  const telegram = channels.find((channel) => channel.provider === 'telegram')
  const memoryGroups = Array.from(memories.reduce((groups, memory) => {
    const key = memory.endUserId ?? ''
    const group = groups.get(key) ?? []
    group.push(memory)
    groups.set(key, group)
    return groups
  }, new Map<string, AgentMemory[]>()))

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
            <div><dt>Instructions</dt><dd>{agent.systemPrompt ? 'Custom prompt set' : 'Riwaq default'}</dd></div>
          </dl>
          <EditAgentInstructionsModal agent={agent} />
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

      <section className="agent-memory-section">
        <header className="section-action-header">
          <div><span className="eyebrow">Durable personalization</span><h3>Memory</h3><p>Facts recalled by semantic relevance. User-specific memories stay isolated from every other identity.</p></div>
          <AddAgentMemoryModal agentId={agent.id} />
        </header>
        {memories.length === 0 ? (
          <div className="list-card"><div className="empty-state"><span>◇</span><h3>No memories yet</h3><p>Durable facts are extracted after conversations, or you can add one manually.</p></div></div>
        ) : memoryGroups.map(([endUserId, group]) => (
          <article className="memory-scope" key={endUserId || 'agent-wide'}>
            <header>
              <div><strong>{memoryScope(endUserId || null)}</strong><span>{group.length} {group.length === 1 ? 'fact' : 'facts'}</span></div>
              {endUserId ? <ForgetAgentUserModal agentId={agent.id} endUserId={endUserId} /> : null}
            </header>
            <div className="list-card">
              {group.map((memory) => (
                <div className="row-item memory-row" key={memory.id}>
                  <span className="row-icon">M</span>
                  <div className="row-copy"><strong>{memory.fact}</strong><span>Updated {memoryDate(memory.updatedAt)}</span></div>
                  <div className="memory-row-actions"><EditAgentMemoryModal agentId={agent.id} memory={memory} /><DeleteAgentMemoryModal agentId={agent.id} memory={memory} /></div>
                </div>
              ))}
            </div>
          </article>
        ))}
        {memories.length === 200 ? <p className="memory-limit-note">Showing the 200 most recently updated memories.</p> : null}
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
