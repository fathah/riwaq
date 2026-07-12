import { and, eq } from 'drizzle-orm'
import { db } from './client'
import { agents, knowledgeBases } from './schema'
import { isUuid } from '../lib/uuid'

// Ownership checks. Every protected handler must verify the resource it's about
// to touch belongs to the caller's org — this is what enforces tenant isolation.
// A non-UUID id can never match a real row, so we short-circuit to "not found"
// rather than letting a `22P02` cast error bubble up as a 500.

export async function getAgentInOrg(agentId: string, orgId: string) {
  if (!isUuid(agentId)) return null
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1)
  return agent ?? null
}

export async function getKbInOrg(kbId: string, orgId: string) {
  if (!isUuid(kbId)) return null
  const [kb] = await db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.orgId, orgId)))
    .limit(1)
  return kb ?? null
}
