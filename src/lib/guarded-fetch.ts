import { env } from '../env'
import { assertPublicUrl } from './url-guard'

// SSRF-hardened fetch for tenant-controlled egress (org-supplied LLM baseURL).
//
// Two additions over plain fetch, targeting the concrete bring-your-own-endpoint
// exploits:
//   1. Re-validate the destination immediately before the call (re-resolves DNS
//      and re-applies the private-IP + allowlist checks), closing the window
//      between config-time validation and connect time.
//   2. redirect: 'error' — a tenant endpoint that answers 3xx with
//      `Location: http://169.254.169.254/…` can no longer make us follow it into
//      cloud metadata or an internal service. Provider APIs never redirect, so
//      this is invisible to legitimate traffic.
//
// Residual: a hostname that resolves public at validation but private at the
// kernel's connect-time lookup (DNS rebinding) is still narrowed but not fully
// closed here; production's mandatory hostname allowlist remains the primary
// control. Socket-level IP pinning is the future hardening.
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url
}

export const guardedFetch: typeof fetch = async (input, init) => {
  await assertPublicUrl(urlOf(input), {
    allowInsecure: env.ALLOW_INSECURE_LLM_URLS,
    allowedHosts: env.LLM_ALLOWED_HOSTS,
  })
  return fetch(input, { ...init, redirect: 'error' })
}
