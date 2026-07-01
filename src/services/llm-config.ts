import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import { env } from '../env'
import { decryptSecret } from '../lib/crypto'
import { DEFAULT_MODEL, type LlmConfig, type Provider } from '../lib/llm'

type AgentOverride = { provider: string | null; model: string | null }

/**
 * Resolve the effective LLM config for a call by merging three layers:
 *
 *   agent override  →  org config  →  .env default
 *
 * Anything an org leaves unset falls back to the deployment's env defaults, so
 * `baseURL` and `model` "default from .env" exactly as configured.
 */
export async function resolveLlmConfig(orgId: string, agent?: AgentOverride): Promise<LlmConfig> {
  const [org] = await db
    .select({
      provider: organizations.llmProvider,
      baseUrl: organizations.llmBaseUrl,
      apiKey: organizations.llmApiKey,
      model: organizations.llmModel,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)

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
  const baseURL =
    (orgApplies ? org?.baseUrl : null) || (provider === 'openai' ? env.OPENAI_BASE_URL : undefined)

  // The org's stored LLM key is encrypted at rest — decrypt it here, in-process,
  // only when it actually applies to this call.
  const orgApiKey = orgApplies && org?.apiKey ? decryptSecret(org.apiKey) : null
  const apiKey = orgApiKey || (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)

  return { provider, model, apiKey, ...(baseURL ? { baseURL } : {}) }
}
