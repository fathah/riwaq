import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, agentKnowledgeBases, knowledgeBases } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { resolveLlmConfig } from '../services/llm-config'
import type { AppEnv } from '../types'

export const agentsRoute = new Hono<AppEnv>()
agentsRoute.use('*', orgAuth)

const createSchema = z.object({
  name: z.string().min(1).max(200),
  systemPrompt: z.string().max(20_000).optional(),
  provider: z.enum(['anthropic', 'openai']).optional(),
  model: z.string().max(200).optional(),
})

// Create an agent + its private (default) KB + the link, atomically.
agentsRoute.post('/agents', async (c) => {
  const orgId = c.get('orgId')
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // provider/model are optional per-agent OVERRIDES — left unset, the agent inherits
  // the org's LLM config, which itself falls back to the .env defaults.
  const result = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        orgId,
        name: parsed.data.name,
        ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
      })
      .returning()

    const [kb] = await tx
      .insert(knowledgeBases)
      .values({ orgId, name: `${parsed.data.name} (private)`, isDefault: true, agentId: agent!.id })
      .returning()

    await tx
      .insert(agentKnowledgeBases)
      .values({ agentId: agent!.id, knowledgeBaseId: kb!.id, orgId })
    return { agent: agent!, privateKbId: kb!.id }
  })

  return c.json(result, 201)
})

// Agent details + the KBs it can read.
agentsRoute.get('/agents/:id', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const kbs = await db
    .select({ id: knowledgeBases.id, name: knowledgeBases.name, isDefault: knowledgeBases.isDefault })
    .from(agentKnowledgeBases)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, agentKnowledgeBases.knowledgeBaseId))
    .where(eq(agentKnowledgeBases.agentId, agent.id))

  // Show the effective LLM config (after agent → org → .env resolution), minus the key.
  const resolved = await resolveLlmConfig(orgId, { provider: agent.provider, model: agent.model })
  const effectiveLlm = {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
  }

  return c.json({ ...agent, knowledgeBases: kbs, effectiveLlm })
})
