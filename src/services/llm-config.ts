import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import { env } from '../env'
import { decryptSecret } from '../lib/crypto'
import { cacheGet, cacheSet, cacheDel } from '../lib/cache'
import { DEFAULT_MODEL, type LlmConfig, type Provider } from '../lib/llm'
import { assertPublicUrl } from '../lib/url-guard'

type AgentOverride = { provider: string | null; model: string | null }
type OrgLlmRow = {
  provider: string | null
  baseUrl: string | null
  apiKey: string | null
  apiKeyEncrypted: boolean
  model: string | null
}

const orgCacheKey = (orgId: string) => `llmcfg:${orgId}`

/** Drop the cached org LLM row (call after any write to it). */
export async function invalidateLlmConfig(orgId: string): Promise<void> {
  await cacheDel(orgCacheKey(orgId))
}

// The org's LLM row is read on every chat turn but changes rarely — cache it in
// DragonflyDB. Only the encrypted apiKey is cached (never plaintext); decryption
// happens after, in-process.
async function loadOrgLlm(orgId: string): Promise<OrgLlmRow | undefined> {
  const cached = await cacheGet<OrgLlmRow>(orgCacheKey(orgId))
  if (cached) return cached
  const [org] = await db
    .select({
      provider: organizations.llmProvider,
      baseUrl: organizations.llmBaseUrl,
      apiKey: organizations.llmApiKey,
      apiKeyEncrypted: organizations.llmApiKeyEncrypted,
      model: organizations.llmModel,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (org) await cacheSet(orgCacheKey(orgId), org)
  return org
}

/**
 * Resolve the effective LLM config for a call by merging three layers:
 *
 *   agent override  →  org config  →  .env default
 *
 * Anything an org leaves unset falls back to the deployment's env defaults, so
 * `baseURL` and `model` "default from .env" exactly as configured.
 */
export async function resolveLlmConfig(orgId: string, agent?: AgentOverride): Promise<LlmConfig> {
  const org = await loadOrgLlm(orgId)

  const envProvider = env.LLM_DEFAULT_PROVIDER as Provider
  const provider = (agent?.provider || org?.provider || envProvider) as Provider

  // The org's (baseUrl, apiKey, model) form one coherent bundle tied to the org's
  // chosen provider (or the env default if the org didn't set one). They only apply
  // when the call's provider matches — otherwise an agent that overrides the provider
  // would wrongly inherit credentials/endpoint meant for a different backend.
  const orgIntendedProvider = (org?.provider as Provider) || envProvider
  const orgApplies = provider === orgIntendedProvider

  const model =
    agent?.model ||
    (orgApplies ? org?.model : null) ||
    (provider === envProvider ? env.LLM_DEFAULT_MODEL : '') ||
    DEFAULT_MODEL[provider]

  // baseURL: org override (if it applies), else the env default for OpenAI.
  const tenantBaseUrl = orgApplies ? org?.baseUrl || null : null
  const baseURL = tenantBaseUrl || (provider === 'openai' ? env.OPENAI_BASE_URL : undefined)

  // The org's stored LLM key is encrypted at rest — decrypt it here, in-process,
  // only when it actually applies to this call.
  const orgApiKey =
    orgApplies && org?.apiKey ? decryptSecret(org.apiKey, org.apiKeyEncrypted) : null
  const apiKey = orgApiKey || (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)

  // Re-resolve and revalidate tenant-controlled destinations immediately before
  // every provider call. This closes the stored-DNS drift window; production's
  // mandatory hostname allowlist remains the primary application-layer policy.
  // The guarded fetch (wired below via guardEgress) re-checks again at connect
  // time and refuses redirects.
  if (tenantBaseUrl) {
    await assertPublicUrl(baseURL!, {
      allowInsecure: env.ALLOW_INSECURE_LLM_URLS,
      allowedHosts: env.LLM_ALLOWED_HOSTS,
    })
  }

  return {
    provider,
    model,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(tenantBaseUrl ? { guardEgress: true } : {}),
  }
}
