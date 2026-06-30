import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { agents, agentKnowledgeBases, knowledgeBases } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg } from '../db/guards'
import { env } from '../env'
import { DEFAULT_MODEL } from '../lib/llm'
import type { AppEnv } from '../types'

export const agentsRoute = new Hono<AppEnv>()
agentsRoute.use('*', orgAuth)

const createSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().optional(),
  provider: z.enum(['anthropic', 'openai']).optional(),
  model: z.string().optional(),
})

// Create an agent + its private (default) KB + the link, atomically.
agentsRoute.post('/agents', async (c) => {
  const orgId = c.get('orgId')
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // Provider defaults to the deployment default; model defaults to that provider's
  // cheap model unless the caller names one explicitly.
  const provider = parsed.data.provider ?? env.LLM_DEFAULT_PROVIDER
  const model = parsed.data.model ?? DEFAULT_MODEL[provider]

  const result = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        orgId,
        name: parsed.data.name,
        provider,
        model,
        ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
      })
      .returning()

    const [kb] = await tx
      .insert(knowledgeBases)
      .values({ orgId, name: `${parsed.data.name} (private)`, isDefault: true })
      .returning()

    await tx.insert(agentKnowledgeBases).values({ agentId: agent!.id, knowledgeBaseId: kb!.id })
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

  return c.json({ ...agent, knowledgeBases: kbs })
})
