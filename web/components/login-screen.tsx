import { loginAction } from '../app/actions'

export function LoginScreen({ error, apiUrl }: { error?: string; apiUrl: string }) {
  return (
    <main className="center-shell">
      <section className="auth-card">
        <div className="brand-lockup">
          <img alt="" aria-hidden="true" className="brand-mark brand-logo" height="38" src="/riwaq-icon.svg" width="38" />
          <div><strong>Riwaq</strong><span>Console</span></div>
        </div>
        <div className="auth-copy">
          <span className="eyebrow">Management access</span>
          <h1>Welcome back.</h1>
          <p>Enter the dashboard token configured on this server. Your organization API key never reaches the browser.</p>
        </div>
        {error ? <div className="banner banner-error">{error}</div> : null}
        <form action={loginAction} className="stack-form">
          <label>
            <span>Dashboard access token</span>
            <input name="token" type="password" autoComplete="current-password" required autoFocus placeholder="••••••••••••••••" />
          </label>
          <button className="button button-primary" type="submit">Open console <span aria-hidden>→</span></button>
        </form>
        <div className="auth-meta"><span className="status-dot" /> Connected to {apiUrl}</div>
      </section>
    </main>
  )
}
