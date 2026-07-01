import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../lib/api-key'
import { assertPublicUrl, UnsafeUrlError } from '../lib/url-guard'
import { env } from '../env'
import type { AppEnv } from '../types'

export const organizationsRoute = new Hono<AppEnv>()

const createSchema = z.object({ name: z.string().min(1).max(200) })

// PUBLIC: bootstrap an org. Returns the API key ONCE — store it; it's the only
// way to authenticate every subsequent request for this tenant. The DB keeps only
// the key's hash, so this is the sole moment the raw key exists.
organizationsRoute.post('/organizations', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const apiKey = generateApiKey()
  const [org] = await db
    .insert(organizations)
    .values({ name: parsed.data.name, apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKeyPrefix(apiKey) })
    .returning({ id: organizations.id, name: organizations.name, createdAt: organizations.createdAt })

  return c.json({ ...org!, apiKey }, 201)
})

// AUTHED: who am I? (Never echoes secrets — the org API key or the LLM key.)
organizationsRoute.get('/organizations/me', orgAuth, async (c) => {
  const orgId = c.get('orgId')
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      createdAt: organizations.createdAt,
      llmProvider: organizations.llmProvider,
      llmBaseUrl: organizations.llmBaseUrl,
      llmModel: organizations.llmModel,
      llmApiKey: organizations.llmApiKey,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)

  return c.json({
    id: org!.id,
    name: org!.name,
    createdAt: org!.createdAt,
    llm: {
      provider: org!.llmProvider,
      baseUrl: org!.llmBaseUrl,
      model: org!.llmModel,
      hasApiKey: !!org!.llmApiKey, // never return the key itself
    },
  })
})

// AUTHED: configure this org's LLM. Each field is optional; send a field to set it,
// send null to clear it (falling back to the .env default). Unspecified fields keep
// their current value.
const llmSchema = z.object({
  provider: z.enum(['anthropic', 'openai']).nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
})

organizationsRoute.put('/organizations/llm', orgAuth, async (c) => {
  const orgId = c.get('orgId')
  const parsed = llmSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // SSRF: a tenant-supplied baseUrl becomes server-side egress, so validate it
  // before storing — reject loopback/private/link-local/metadata and non-https.
  if (parsed.data.baseUrl) {
    try {
      await assertPublicUrl(parsed.data.baseUrl, {
        allowInsecure: env.ALLOW_INSECURE_LLM_URLS,
        allowedHosts: env.LLM_ALLOWED_HOSTS,
      })
    } catch (err) {
      if (err instanceof UnsafeUrlError) return c.json({ error: `baseUrl rejected: ${err.message}` }, 400)
      throw err
    }
  }

  const patch: Record<string, string | null> = {}
  if ('provider' in parsed.data) patch.llmProvider = parsed.data.provider ?? null
  if ('baseUrl' in parsed.data) patch.llmBaseUrl = parsed.data.baseUrl ?? null
  if ('apiKey' in parsed.data) patch.llmApiKey = parsed.data.apiKey ?? null
  if ('model' in parsed.data) patch.llmModel = parsed.data.model ?? null

  if (Object.keys(patch).length === 0) return c.json({ error: 'no fields to update' }, 400)

  const [org] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, orgId))
    .returning({
      llmProvider: organizations.llmProvider,
      llmBaseUrl: organizations.llmBaseUrl,
      llmModel: organizations.llmModel,
      llmApiKey: organizations.llmApiKey,
    })

  return c.json({
    llm: {
      provider: org!.llmProvider,
      baseUrl: org!.llmBaseUrl,
      model: org!.llmModel,
      hasApiKey: !!org!.llmApiKey,
    },
  })
})
