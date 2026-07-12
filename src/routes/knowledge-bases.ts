import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { knowledgeBases, agentKnowledgeBases } from '../db/schema'
import { orgAuth } from '../middleware/auth'
import { getAgentInOrg, getKbInOrg } from '../db/guards'
import { pageParams } from '../lib/pagination'
import type { AppEnv } from '../types'

// Org is implicit from the API key, so KB endpoints don't repeat /organizations/:id.
export const knowledgeBasesRoute = new Hono<AppEnv>()
knowledgeBasesRoute.use('*', orgAuth)

const createSchema = z.object({ name: z.string().min(1) })
const linkSchema = z.object({ knowledgeBaseId: z.string().uuid() })

// Create a shared KB (org-level, linkable to many agents).
knowledgeBasesRoute.post('/knowledge-bases', async (c) => {
  const orgId = c.get('orgId')
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const [kb] = await db
    .insert(knowledgeBases)
    .values({ orgId, name: parsed.data.name, isDefault: false })
    .returning()
  return c.json(kb!, 201)
})

// List all KBs in the org (private + shared), paginated newest first.
knowledgeBasesRoute.get('/knowledge-bases', async (c) => {
  const orgId = c.get('orgId')
  const { limit, offset } = pageParams((n) => c.req.query(n))
  const rows = await db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.orgId, orgId))
    .orderBy(desc(knowledgeBases.createdAt))
    .limit(limit)
    .offset(offset)
  return c.json(rows)
})

// KBs a specific agent can read.
knowledgeBasesRoute.get('/agents/:id/knowledge-bases', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const rows = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      isDefault: knowledgeBases.isDefault,
    })
    .from(agentKnowledgeBases)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, agentKnowledgeBases.knowledgeBaseId))
    .where(eq(agentKnowledgeBases.agentId, agent.id))
  return c.json(rows)
})

// Link a shared KB to an agent. Both must belong to the caller's org.
knowledgeBasesRoute.post('/agents/:id/knowledge-bases', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const parsed = linkSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const kb = await getKbInOrg(parsed.data.knowledgeBaseId, orgId)
  if (!kb) return c.json({ error: 'knowledge base not found' }, 404)
  // Private KBs belong to exactly one agent and are never shareable — linking one
  // to another agent would leak that agent's private documents. Only shared KBs link.
  if (kb.isDefault) return c.json({ error: 'cannot link a private KB to another agent' }, 400)

  await db
    .insert(agentKnowledgeBases)
    .values({ agentId: agent.id, knowledgeBaseId: kb.id, orgId })
    .onConflictDoNothing()
  return c.json({ ok: true, agentId: agent.id, knowledgeBaseId: kb.id }, 201)
})

// Unlink a shared KB. Refuse to unlink the agent's own private KB this way.
knowledgeBasesRoute.delete('/agents/:id/knowledge-bases/:kbId', async (c) => {
  const orgId = c.get('orgId')
  const agent = await getAgentInOrg(c.req.param('id'), orgId)
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const kb = await getKbInOrg(c.req.param('kbId'), orgId)
  if (!kb) return c.json({ error: 'knowledge base not found' }, 404)
  if (kb.isDefault) return c.json({ error: 'cannot unlink an agent\'s private KB' }, 400)

  await db
    .delete(agentKnowledgeBases)
    .where(
      and(
        eq(agentKnowledgeBases.agentId, agent.id),
        eq(agentKnowledgeBases.knowledgeBaseId, kb.id),
      ),
    )
  return c.json({ ok: true })
})
