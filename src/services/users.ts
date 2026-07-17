import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  agents,
  conversations,
  endUserIdentities,
  endUsers,
  memories,
  reminders,
} from '../db/schema'

export class UserIdentityConflict extends Error {
  status = 409
  constructor(public currentUserId: string) {
    super(`platform identity is already connected to user '${currentUserId}'`)
  }
}

export type PublicEndUser = {
  id: string
  displayName: string | null
  identityCount: number
  memoryCount: number
  createdAt: Date
  updatedAt: Date
}

export type PublicUserIdentity = {
  id: string
  provider: string
  namespace: string
  externalUserId: string
  createdAt: Date
}

export async function ensureEndUser(orgId: string, id: string, displayName?: string | null): Promise<void> {
  await db
    .insert(endUsers)
    .values({ orgId, id, displayName: displayName?.trim() || null })
    .onConflictDoNothing({ target: [endUsers.orgId, endUsers.id] })
  if (displayName?.trim()) {
    await db
      .update(endUsers)
      .set({ displayName: displayName.trim(), updatedAt: new Date() })
      .where(and(eq(endUsers.orgId, orgId), eq(endUsers.id, id), isNull(endUsers.displayName)))
  }
}

export async function listEndUsers(orgId: string, limit: number, offset: number): Promise<PublicEndUser[]> {
  const rows = await db
    .select({
      id: endUsers.id,
      displayName: endUsers.displayName,
      identityCount: sql<number>`(
        SELECT count(*)::int FROM end_user_identities identity
        WHERE identity.org_id = "end_users"."org_id" AND identity.end_user_id = "end_users"."id"
      )`,
      memoryCount: sql<number>`(
        SELECT count(*)::int FROM memories memory
        JOIN agents agent ON agent.id = memory.agent_id
        WHERE agent.org_id = "end_users"."org_id" AND memory.end_user_id = "end_users"."id"
      )`,
      createdAt: endUsers.createdAt,
      updatedAt: endUsers.updatedAt,
    })
    .from(endUsers)
    .where(eq(endUsers.orgId, orgId))
    .orderBy(desc(endUsers.updatedAt), endUsers.id)
    .limit(limit)
    .offset(offset)
  return rows.map((row) => ({ ...row, identityCount: Number(row.identityCount), memoryCount: Number(row.memoryCount) }))
}

export async function getEndUser(orgId: string, id: string): Promise<PublicEndUser | null> {
  const users = await db
    .select({
      id: endUsers.id,
      displayName: endUsers.displayName,
      identityCount: sql<number>`(
        SELECT count(*)::int FROM end_user_identities identity
        WHERE identity.org_id = "end_users"."org_id" AND identity.end_user_id = "end_users"."id"
      )`,
      memoryCount: sql<number>`(
        SELECT count(*)::int FROM memories memory
        JOIN agents agent ON agent.id = memory.agent_id
        WHERE agent.org_id = "end_users"."org_id" AND memory.end_user_id = "end_users"."id"
      )`,
      createdAt: endUsers.createdAt,
      updatedAt: endUsers.updatedAt,
    })
    .from(endUsers)
    .where(and(eq(endUsers.orgId, orgId), eq(endUsers.id, id)))
    .limit(1)
  const user = users[0]
  return user ? { ...user, identityCount: Number(user.identityCount), memoryCount: Number(user.memoryCount) } : null
}

export function listUserIdentities(orgId: string, endUserId: string): Promise<PublicUserIdentity[]> {
  return db
    .select({
      id: endUserIdentities.id,
      provider: endUserIdentities.provider,
      namespace: endUserIdentities.namespace,
      externalUserId: endUserIdentities.externalUserId,
      createdAt: endUserIdentities.createdAt,
    })
    .from(endUserIdentities)
    .where(and(eq(endUserIdentities.orgId, orgId), eq(endUserIdentities.endUserId, endUserId)))
    .orderBy(endUserIdentities.provider, endUserIdentities.namespace, endUserIdentities.externalUserId)
}

export async function listUserMemories(orgId: string, endUserId: string, limit: number, offset: number) {
  return db
    .select({
      id: memories.id,
      agentId: memories.agentId,
      agentName: agents.name,
      endUserId: memories.endUserId,
      fact: memories.fact,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(agents, eq(agents.id, memories.agentId))
    .where(and(eq(agents.orgId, orgId), eq(memories.endUserId, endUserId)))
    .orderBy(desc(memories.updatedAt))
    .limit(limit)
    .offset(offset)
}

export async function updateEndUser(orgId: string, id: string, displayName: string | null): Promise<boolean> {
  const updated = await db
    .update(endUsers)
    .set({ displayName: displayName?.trim() || null, updatedAt: new Date() })
    .where(and(eq(endUsers.orgId, orgId), eq(endUsers.id, id)))
    .returning({ id: endUsers.id })
  return updated.length > 0
}

export async function connectEndUser(input: {
  orgId: string
  userId: string
  displayName?: string | null
  provider?: string
  namespace?: string
  externalUserId?: string
  mergeExisting?: boolean
}): Promise<{ userId: string; identity: PublicUserIdentity | null; mergedFrom: string | null }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(endUsers)
      .values({ orgId: input.orgId, id: input.userId, displayName: input.displayName?.trim() || null })
      .onConflictDoNothing({ target: [endUsers.orgId, endUsers.id] })
    if (input.displayName?.trim()) {
      await tx
        .update(endUsers)
        .set({ displayName: input.displayName.trim(), updatedAt: new Date() })
        .where(and(eq(endUsers.orgId, input.orgId), eq(endUsers.id, input.userId)))
    }

    if (!input.provider || !input.externalUserId) {
      return { userId: input.userId, identity: null, mergedFrom: null }
    }
    const namespace = input.namespace || 'default'
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${
      `user-identity:${input.orgId}:${input.provider}:${namespace}:${input.externalUserId}`
    }))`)
    const [existing] = await tx
      .select({ id: endUserIdentities.id, endUserId: endUserIdentities.endUserId })
      .from(endUserIdentities)
      .where(and(
        eq(endUserIdentities.orgId, input.orgId),
        eq(endUserIdentities.provider, input.provider),
        eq(endUserIdentities.namespace, namespace),
        eq(endUserIdentities.externalUserId, input.externalUserId),
      ))
      .limit(1)

    let mergedFrom: string | null = null
    if (existing && existing.endUserId !== input.userId) {
      if (!input.mergeExisting) throw new UserIdentityConflict(existing.endUserId)
      mergedFrom = existing.endUserId
      const orgAgents = await tx.select({ id: agents.id }).from(agents).where(eq(agents.orgId, input.orgId))
      const agentIds = orgAgents.map((agent) => agent.id)
      if (agentIds.length > 0) {
        await tx
          .update(conversations)
          .set({ endUserId: input.userId })
          .where(and(eq(conversations.endUserId, mergedFrom), inArray(conversations.agentId, agentIds)))
        await tx
          .update(memories)
          .set({ endUserId: input.userId, updatedAt: new Date() })
          .where(and(eq(memories.endUserId, mergedFrom), inArray(memories.agentId, agentIds)))
      }
      await tx
        .update(reminders)
        .set({ endUserId: input.userId, updatedAt: new Date() })
        .where(and(eq(reminders.orgId, input.orgId), eq(reminders.endUserId, mergedFrom)))
      await tx.execute(sql`
        INSERT INTO learned_answer_votes (learned_answer_id, end_user_id, created_at)
        SELECT vote.learned_answer_id, ${input.userId}, vote.created_at
        FROM learned_answer_votes vote
        JOIN learned_answers answer ON answer.id = vote.learned_answer_id
        WHERE answer.org_id = ${input.orgId} AND vote.end_user_id = ${mergedFrom}
        ON CONFLICT (learned_answer_id, end_user_id) DO NOTHING
      `)
      await tx.execute(sql`
        DELETE FROM learned_answer_votes vote
        USING learned_answers answer
        WHERE answer.id = vote.learned_answer_id
          AND answer.org_id = ${input.orgId}
          AND vote.end_user_id = ${mergedFrom}
      `)
      await tx
        .update(endUserIdentities)
        .set({ endUserId: input.userId })
        .where(and(eq(endUserIdentities.orgId, input.orgId), eq(endUserIdentities.endUserId, mergedFrom)))
      await tx
        .delete(endUsers)
        .where(and(eq(endUsers.orgId, input.orgId), eq(endUsers.id, mergedFrom)))
    }

    let identityId = existing?.id
    if (!identityId) {
      const [created] = await tx
        .insert(endUserIdentities)
        .values({
          orgId: input.orgId,
          endUserId: input.userId,
          provider: input.provider,
          namespace,
          externalUserId: input.externalUserId,
        })
        .returning({ id: endUserIdentities.id })
      identityId = created!.id
    }
    const [identity] = await tx
      .select({
        id: endUserIdentities.id,
        provider: endUserIdentities.provider,
        namespace: endUserIdentities.namespace,
        externalUserId: endUserIdentities.externalUserId,
        createdAt: endUserIdentities.createdAt,
      })
      .from(endUserIdentities)
      .where(eq(endUserIdentities.id, identityId))
      .limit(1)
    return { userId: input.userId, identity: identity!, mergedFrom }
  })
}

export async function resolvePlatformUser(input: {
  orgId: string
  provider: string
  namespace?: string
  externalUserId: string
  fallbackUserId: string
  displayName?: string | null
}): Promise<string> {
  const namespace = input.namespace || 'default'
  const [identity] = await db
    .select({ endUserId: endUserIdentities.endUserId })
    .from(endUserIdentities)
    .where(and(
      eq(endUserIdentities.orgId, input.orgId),
      eq(endUserIdentities.provider, input.provider),
      eq(endUserIdentities.namespace, namespace),
      eq(endUserIdentities.externalUserId, input.externalUserId),
    ))
    .limit(1)
  if (identity) return identity.endUserId
  try {
    const connected = await connectEndUser({
      orgId: input.orgId,
      userId: input.fallbackUserId,
      displayName: input.displayName,
      provider: input.provider,
      namespace,
      externalUserId: input.externalUserId,
    })
    return connected.userId
  } catch (error) {
    // A manual connect may win the race between the initial read and advisory
    // lock. That is a valid resolution, not a failed channel event.
    if (error instanceof UserIdentityConflict) return error.currentUserId
    throw error
  }
}

export async function disconnectUserIdentity(orgId: string, endUserId: string, identityId: string): Promise<boolean> {
  const deleted = await db
    .delete(endUserIdentities)
    .where(and(
      eq(endUserIdentities.id, identityId),
      eq(endUserIdentities.orgId, orgId),
      eq(endUserIdentities.endUserId, endUserId),
    ))
    .returning({ id: endUserIdentities.id })
  return deleted.length > 0
}
