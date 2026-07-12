import { createHmac } from 'node:crypto'
import { assertPublicUrl } from './url-guard'
import { env } from './../env'

// Signed outbound webhooks (reminder delivery). The payload is HMAC-signed so the
// receiving org backend can verify it genuinely came from us and wasn't tampered
// with or replayed (the timestamp is part of the signed material).

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export type WebhookResult = { ok: boolean; status: number }

/**
 * POST a signed JSON payload to a tenant-configured webhook. SSRF-guarded: the URL
 * is re-validated against private/reserved addresses at call time and redirects are
 * refused (a webhook host can't bounce us into an internal service). Throws on
 * network/timeout errors; returns { ok, status } otherwise.
 */
export async function postSignedWebhook(url: string, secret: string, payload: unknown): Promise<WebhookResult> {
  // Webhooks are org-controlled but need the same private-IP protection as LLM
  // egress. Not subject to the LLM host allowlist — a different destination class.
  await assertPublicUrl(url, { allowInsecure: env.ALLOW_INSECURE_LLM_URLS })

  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'riwaq-webhooks/1',
      'x-riwaq-timestamp': timestamp,
      'x-riwaq-signature': signWebhook(secret, timestamp, body),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(env.REMINDER_WEBHOOK_TIMEOUT_MS),
  })
  return { ok: res.status >= 200 && res.status < 300, status: res.status }
}
