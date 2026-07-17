import { switchOrganizationAction } from '../../actions'
import { CreateOrganizationModal, RenameOrganizationModal } from '../../../components/organization-modals'
import { getManagedOrganizations, getOrganization, organizationManagementEnabled } from '../../../lib/riwaq'

function date(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
}

export default async function OrganizationsPage() {
  const current = await getOrganization()
  const enabled = organizationManagementEnabled()
  const organizations = enabled ? await getManagedOrganizations() : []

  return (
    <div className="page-content">
      <header className="page-header"><div><span className="eyebrow">Administration</span><h2>Organizations</h2><p>Create isolated workspaces, rename them, and switch the console context without rotating API keys.</p></div>{enabled ? <CreateOrganizationModal /> : null}</header>
      {!enabled ? <section className="management-disabled page-card"><h3>Organization management is not configured</h3><p>Set <code>RIWAQ_ADMIN_TOKEN</code> on the dashboard server to the API&apos;s <code>ADMIN_TOKEN</code>, then restart the console.</p></section> : null}
      {enabled ? <section className="organization-grid">
        {organizations.map((organization) => {
          const active = organization.id === current.id
          return (
            <article className={`organization-card page-card ${active ? 'organization-active' : ''}`} key={organization.id}>
              <header><span className="org-avatar">{organization.name.slice(0, 2).toUpperCase()}</span><span className={active ? 'pill' : 'pill pill-neutral'}>{active ? 'Active' : 'Workspace'}</span></header>
              <h3>{organization.name}</h3>
              <dl><div><dt>Created</dt><dd>{date(organization.createdAt)}</dd></div><div><dt>API key</dt><dd>{organization.apiKeyPrefix ? `${organization.apiKeyPrefix}…` : 'Configured'}</dd></div><div><dt>LLM</dt><dd>{organization.llm.provider || 'Default'} · {organization.llm.model || 'Default model'}</dd></div></dl>
              <footer>
                <RenameOrganizationModal organization={organization} />
                {!active ? <form action={switchOrganizationAction}><input name="organizationId" type="hidden" value={organization.id} /><button className="button button-primary" type="submit">Switch workspace</button></form> : null}
              </footer>
            </article>
          )
        })}
      </section> : null}
    </div>
  )
}
