import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { agentChannels, organizations } from '../db/schema'
import { encryptSecret, encryptionEnabled } from '../lib/crypto'

/**
 * One-way startup migration for legacy plaintext org LLM credentials. The
 * explicit encrypted-state column avoids guessing based on secret contents.
 */
export async function encryptLegacyLlmSecrets(): Promise<number> {
  if (!encryptionEnabled()) return 0

  const rows = await db
    .select({ id: organizations.id, apiKey: organizations.llmApiKey })
    .from(organizations)
    .where(and(isNotNull(organizations.llmApiKey), eq(organizations.llmApiKeyEncrypted, false)))

  let migrated = 0
  for (const row of rows) {
    if (!row.apiKey) continue
    const updated = await db
      .update(organizations)
      .set({ llmApiKey: encryptSecret(row.apiKey), llmApiKeyEncrypted: true })
      .where(and(eq(organizations.id, row.id), eq(organizations.llmApiKeyEncrypted, false)))
      .returning({ id: organizations.id })
    migrated += updated.length
  }
  return migrated
}

/** Seal channel credentials that were created in development before an
 * encryption key was configured. Production never leaves a bot token plaintext. */
export async function encryptLegacyChannelSecrets(): Promise<number> {
  if (!encryptionEnabled()) return 0
  const rows = await db
    .select({ id: agentChannels.id, credential: agentChannels.credential })
    .from(agentChannels)
    .where(eq(agentChannels.credentialEncrypted, false))

  let migrated = 0
  for (const row of rows) {
    const updated = await db
      .update(agentChannels)
      .set({ credential: encryptSecret(row.credential), credentialEncrypted: true, updatedAt: new Date() })
      .where(and(eq(agentChannels.id, row.id), eq(agentChannels.credentialEncrypted, false)))
      .returning({ id: agentChannels.id })
    migrated += updated.length
  }
  return migrated
}
