import { and, eq } from 'drizzle-orm'
import { db } from './client'
import { agents, knowledgeBases } from './schema'

// Ownership checks. Every protected handler must verify the resource it's about
// to touch belongs to the caller's org — this is what enforces tenant isolation.

export async function getAgentInOrg(agentId: string, orgId: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1)
  return agent ?? null
}

export async function getKbInOrg(kbId: string, orgId: string) {
  const [kb] = await db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.orgId, orgId)))
    .limit(1)
  return kb ?? null
}
