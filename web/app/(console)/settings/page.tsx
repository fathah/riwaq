import { EditLlmModal } from '../../../components/action-modals'
import { getOrganization } from '../../../lib/riwaq'

export default async function SettingsPage() {
  const organization = await getOrganization()
  return (
    <div className="page-content">
      <header className="page-header"><div><span className="eyebrow">Organization</span><h2>Settings</h2><p>Control the default language model inherited by your agents.</p></div></header>
      <section className="settings-summary page-card">
        <header><div><span className="eyebrow">Provider configuration</span><h3>Organization LLM</h3></div><span className="pill">{organization.llm.hasApiKey ? 'Key configured' : 'Deployment key'}</span></header>
        <dl>
          <div><dt>Provider</dt><dd>{organization.llm.provider || 'Deployment default'}</dd></div>
          <div><dt>Model</dt><dd>{organization.llm.model || 'Provider default'}</dd></div>
          <div><dt>Base URL</dt><dd>{organization.llm.baseUrl || 'Deployment default'}</dd></div>
          <div><dt>API key</dt><dd>{organization.llm.hasApiKey ? '•••••••• configured' : 'Not configured for organization'}</dd></div>
        </dl>
        <footer><p>Credentials are encrypted by the Riwaq API and are never returned to the console.</p><EditLlmModal organization={organization} /></footer>
      </section>
    </div>
  )
}
