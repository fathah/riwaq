import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { organizations } from '../db/schema'
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
