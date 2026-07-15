import { getAgents, getKnowledgeBases, getOrganization, getUsage } from '../../../lib/riwaq'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function ratio(value: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(100, Math.max(0, (value / limit) * 100))
}

export default async function OverviewPage() {
  const [organization, usage, agents, knowledgeBases] = await Promise.all([
    getOrganization(),
    getUsage(),
    getAgents(),
    getKnowledgeBases(),
  ])
  const totalTokens = usage.usage.inputTokens + usage.usage.outputTokens
  const tokenRatio = ratio(totalTokens, usage.limits.totalTokens)

  return (
    <div className="page-content">
      <header className="page-header"><div><span className="eyebrow">Live workspace</span><h2>Overview</h2><p>Usage, capacity, and activity across your Riwaq organization.</p></div></header>
      <section className="stat-grid">
        <article className="stat-card stat-accent"><span>Agents</span><strong>{formatNumber(agents.length)}</strong><small>{agents.length ? 'Ready to serve users' : 'Create your first agent'}</small></article>
        <article className="stat-card"><span>Chat requests</span><strong>{formatNumber(usage.usage.chatRequests)}</strong><small>{formatNumber(totalTokens)} total tokens</small></article>
        <article className="stat-card"><span>Documents</span><strong>{formatNumber(usage.usage.documents)}</strong><small>{formatNumber(usage.usage.storedChars)} stored characters</small></article>
        <article className="stat-card"><span>Knowledge bases</span><strong>{formatNumber(knowledgeBases.length)}</strong><small>{knowledgeBases.filter((kb) => !kb.isDefault).length} shared</small></article>
      </section>
      <section className="usage-card">
        <div><span className="eyebrow">Organization quota</span><h3>Token usage</h3><p>Input and output tokens recorded across all agents in {organization.name}.</p></div>
        <div className="usage-meter"><div><strong>{formatNumber(totalTokens)}</strong><span>of {formatNumber(usage.limits.totalTokens)}</span></div><div className="progress"><span style={{ width: `${tokenRatio}%` }} /></div><small>{tokenRatio.toFixed(1)}% used</small></div>
      </section>
    </div>
  )
}
