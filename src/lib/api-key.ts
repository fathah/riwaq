import { randomBytes, createHash } from 'node:crypto'

// Organization API keys. The raw key is high-entropy (24 random bytes) and is
// returned to the caller exactly once; the database stores only its SHA-256 hash
// (for the auth lookup) and a short prefix (for display). See migration 0005.

const PREFIX = 'riwaq_'

export function generateApiKey(): string {
  return PREFIX + randomBytes(24).toString('hex')
}

/** Lookup hash for an API key. Hex SHA-256 — matches the DB's pgcrypto digest. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Non-secret display prefix, e.g. "riwaq_1a2b3c…" (first 12 chars). */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12)
}
