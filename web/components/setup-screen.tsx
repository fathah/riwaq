import { logoutAction } from '../app/actions'

type SetupScreenProps = {
  issues: string[]
  apiUrl?: string
  connectionError?: boolean
}

export function SetupScreen({ issues, apiUrl, connectionError = false }: SetupScreenProps) {
  const displayUrl = apiUrl || 'http://localhost:3000'
  return (
    <main className="setup-shell">
      <header className="setup-header">
        <div className="brand-lockup"><span className="brand-mark">R</span><div><strong>Riwaq</strong><span>Console</span></div></div>
        <span className="setup-step">First-run setup</span>
      </header>

      <section className="setup-hero">
        <div>
          <span className="eyebrow">{connectionError ? 'Connection needs attention' : 'Configuration required'}</span>
          <h1>{connectionError ? 'The console cannot reach Riwaq.' : 'Connect your Riwaq organization.'}</h1>
          <p>The console reads credentials only on the Next.js server. Set the variables below, then restart the web process.</p>
        </div>
        <div className="issue-list">
          {issues.map((issue) => <div className="issue" key={issue}><span>!</span>{issue}</div>)}
        </div>
      </section>

      <section className="setup-grid">
        <article className="setup-card">
          <span className="step-number">01</span>
          <h2>Create an organization</h2>
          <p>Skip this if you already have an organization API key.</p>
          <pre><code>{`curl -X POST ${displayUrl}/organizations \\\n  -H "content-type: application/json" \\\n  -H "x-admin-token: $ADMIN_TOKEN" \\\n  -d '{"name":"My organization"}'`}</code></pre>
          <small>Save the returned <code>apiKey</code>. Riwaq displays it only once.</small>
        </article>

        <article className="setup-card">
          <span className="step-number">02</span>
          <h2>Set web environment variables</h2>
          <p>Use <code>web/.env.local</code> for local development or the root <code>.env</code> with Docker Compose.</p>
          <pre><code>{`RIWAQ_API_URL=${displayUrl}\nRIWAQ_API_KEY=riwaq_replace_me\nRIWAQ_ADMIN_TOKEN=copy_api_admin_token\nRIWAQ_DASHBOARD_TOKEN=replace_with_32_plus_chars`}</code></pre>
          <small>The admin token enables organization management. Generate the dashboard access token with <code>openssl rand -hex 32</code>.</small>
        </article>

        <article className="setup-card">
          <span className="step-number">03</span>
          <h2>Restart the console</h2>
          <p>The page automatically becomes the login screen when all required values are available.</p>
          <pre><code>{`# Docker Compose\ndocker compose up -d --force-recreate web\n\n# Local development\ncd web && npm run dev`}</code></pre>
          {connectionError ? <form action={logoutAction}><button className="text-button" type="submit">Clear login and retry</button></form> : null}
        </article>
      </section>

      <footer className="setup-footer">Secrets stay server-side · HTTP-only dashboard session · No browser API key storage</footer>
    </main>
  )
}
