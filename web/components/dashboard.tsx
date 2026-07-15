import { createAgentAction, createKnowledgeBaseAction, logoutAction, updateLlmAction } from '../app/actions'
import type { Agent, KnowledgeBase, Organization, UsageSnapshot } from '../lib/riwaq'

type DashboardProps = {
  ready: { ready: boolean }
  organization: Organization
  usage: UsageSnapshot
  agents: Agent[]
  knowledgeBases: KnowledgeBase[]
  apiUrl: string
  notice?: string
  error?: string
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function ratio(value: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(100, Math.max(0, (value / limit) * 100))
}

function date(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

function Mark({ name }: { name: 'grid' | 'bot' | 'book' | 'settings' }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    bot: <><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V3M9 3h6"/></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M8 8h8M8 12h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  }
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

export function Dashboard({ ready, organization, usage, agents, knowledgeBases, apiUrl, notice, error }: DashboardProps) {
  const totalTokens = usage.usage.inputTokens + usage.usage.outputTokens
  const sharedKbs = knowledgeBases.filter((kb) => !kb.isDefault)

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-mark">R</span><div><strong>Riwaq</strong><span>Console</span></div></div>
        <nav>
          <a className="nav-active" href="#overview"><Mark name="grid" />Overview</a>
          <a href="#agents"><Mark name="bot" />Agents<span>{agents.length}</span></a>
          <a href="#knowledge"><Mark name="book" />Knowledge<span>{knowledgeBases.length}</span></a>
          <a href="#settings"><Mark name="settings" />Settings</a>
        </nav>
        <div className="sidebar-foot">
          <div className="api-state"><span className={ready.ready ? 'status-dot' : 'status-dot status-dot-error'} /><div><strong>API {ready.ready ? 'operational' : 'not ready'}</strong><small>{apiUrl}</small></div></div>
          <form action={logoutAction}><button className="logout-button" type="submit">Lock console</button></form>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="topbar">
          <div><span className="eyebrow">Organization workspace</span><h1>{organization.name}</h1></div>
          <div className="org-avatar">{organization.name.slice(0, 2).toUpperCase()}</div>
        </header>

        {notice ? <div className="banner banner-success">✓ {notice}</div> : null}
        {error ? <div className="banner banner-error">{error}</div> : null}

        <section id="overview" className="section-block">
          <div className="section-heading"><div><span className="eyebrow">Live workspace</span><h2>Overview</h2></div><span className="updated">Created {date(organization.createdAt)}</span></div>
          <div className="stat-grid">
            <article className="stat-card stat-accent"><span>Agents</span><strong>{formatNumber(agents.length)}</strong><small>{agents.length ? 'Ready to serve users' : 'Create your first agent'}</small></article>
            <article className="stat-card"><span>Chat requests</span><strong>{formatNumber(usage.usage.chatRequests)}</strong><small>{formatNumber(totalTokens)} total tokens</small></article>
            <article className="stat-card"><span>Documents</span><strong>{formatNumber(usage.usage.documents)}</strong><small>{formatNumber(usage.usage.storedChars)} stored characters</small></article>
            <article className="stat-card"><span>Knowledge bases</span><strong>{formatNumber(knowledgeBases.length)}</strong><small>{sharedKbs.length} shared across agents</small></article>
          </div>
          <div className="usage-card">
            <div><span className="eyebrow">Organization quota</span><h3>Token usage</h3><p>Input and output tokens recorded across all agents.</p></div>
            <div className="usage-meter"><div><strong>{formatNumber(totalTokens)}</strong><span>of {formatNumber(usage.limits.totalTokens)}</span></div><div className="progress"><span style={{ width: `${ratio(totalTokens, usage.limits.totalTokens)}%` }} /></div><small>{ratio(totalTokens, usage.limits.totalTokens).toFixed(1)}% used</small></div>
          </div>
        </section>

        <section id="agents" className="section-block">
          <div className="section-heading"><div><span className="eyebrow">RAG + memory</span><h2>Agents</h2></div></div>
          <div className="split-layout">
            <div className="list-card">
              {agents.length === 0 ? <div className="empty-state"><span>✦</span><h3>No agents yet</h3><p>Create one to receive a private knowledge base automatically.</p></div> : agents.map((agent) => (
                <article className="row-item" key={agent.id}>
                  <span className="row-icon">{agent.name.slice(0, 1).toUpperCase()}</span>
                  <div className="row-copy"><strong>{agent.name}</strong><span>{agent.provider || 'Inherited provider'} · {agent.model || 'Default model'}</span></div>
                  <div className="row-meta"><span>{date(agent.createdAt)}</span><code>{agent.id.slice(0, 8)}</code></div>
                </article>
              ))}
            </div>
            <form action={createAgentAction} className="panel-form">
              <div><span className="eyebrow">New agent</span><h3>Create an agent</h3><p>A private knowledge base is created automatically.</p></div>
              <label><span>Name</span><input name="name" required maxLength={200} placeholder="Customer support" /></label>
              <label><span>System prompt</span><textarea name="systemPrompt" rows={4} maxLength={20000} placeholder="You are a precise support assistant…" /></label>
              <div className="form-row">
                <label><span>Provider</span><select name="provider" defaultValue=""><option value="">Inherit</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select></label>
                <label><span>Model</span><input name="model" placeholder="Inherit default" /></label>
              </div>
              <button className="button button-primary" type="submit">Create agent <span>+</span></button>
            </form>
          </div>
        </section>

        <section id="knowledge" className="section-block">
          <div className="section-heading"><div><span className="eyebrow">Grounded answers</span><h2>Knowledge bases</h2></div></div>
          <div className="split-layout">
            <div className="list-card">
              {knowledgeBases.map((kb) => (
                <article className="row-item" key={kb.id}>
                  <span className={`row-icon ${kb.isDefault ? '' : 'row-icon-violet'}`}><Mark name="book" /></span>
                  <div className="row-copy"><strong>{kb.name}</strong><span>{kb.isDefault ? 'Private agent knowledge' : 'Shared organization knowledge'}</span></div>
                  <div className="row-meta"><span className={`pill ${kb.isDefault ? '' : 'pill-violet'}`}>{kb.isDefault ? 'Private' : 'Shared'}</span><code>{kb.id.slice(0, 8)}</code></div>
                </article>
              ))}
            </div>
            <form action={createKnowledgeBaseAction} className="panel-form panel-form-compact">
              <div><span className="eyebrow">Shared knowledge</span><h3>Create a knowledge base</h3><p>Shared knowledge can be linked to multiple agents in this organization.</p></div>
              <label><span>Name</span><input name="name" required placeholder="Company policies" /></label>
              <button className="button button-primary" type="submit">Create knowledge base <span>+</span></button>
            </form>
          </div>
        </section>

        <section id="settings" className="section-block">
          <div className="section-heading"><div><span className="eyebrow">Provider configuration</span><h2>Organization LLM</h2></div><span className="pill">{organization.llm.hasApiKey ? 'Key configured' : 'Using deployment key'}</span></div>
          <form action={updateLlmAction} className="settings-card">
            <label><span>Provider</span><select name="provider" defaultValue={organization.llm.provider ?? ''}><option value="">Keep current / deployment default</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select></label>
            <label><span>Model</span><input name="model" defaultValue={organization.llm.model ?? ''} placeholder="Deployment default" /></label>
            <label className="wide"><span>Base URL</span><input name="baseUrl" type="url" defaultValue={organization.llm.baseUrl ?? ''} placeholder="https://api.openai.com/v1" /></label>
            <label className="wide"><span>New API key</span><input name="apiKey" type="password" placeholder={organization.llm.hasApiKey ? 'Leave blank to keep current key' : 'Enter a provider key'} autoComplete="new-password" /></label>
            <div className="wide settings-action"><p>Only non-empty fields are updated. Provider credentials are encrypted by the Riwaq API.</p><button className="button button-primary" type="submit">Save settings</button></div>
          </form>
        </section>
      </section>
    </main>
  )
}
