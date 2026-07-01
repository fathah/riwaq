import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '../env'

// Envelope encryption for secrets stored at rest (tenant LLM API keys). When a
// master key is configured (SECRET_ENCRYPTION_KEY), values are sealed with
// AES-256-GCM; otherwise they are stored as-is (development). Decryption detects
// the format, so plaintext legacy values keep working after the key is introduced.
//
// This protects a stolen database dump. It cannot hide the key from the process
// that must present it to the provider — the raw key exists in memory only at
// call time, never logged, never returned by the API.

const PREFIX = 'enc:v1:'

// Derive a 32-byte key from the configured secret (any length → 32 bytes).
function masterKey(): Buffer | null {
  if (!env.SECRET_ENCRYPTION_KEY) return null
  return createHash('sha256').update(env.SECRET_ENCRYPTION_KEY).digest()
}

export const encryptionEnabled = () => masterKey() !== null

/** Seal a secret for storage. Returns plaintext unchanged if no master key is set. */
export function encryptSecret(plaintext: string): string {
  const key = masterKey()
  if (!key) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':')
}

/** Open a stored secret. Handles both sealed (`enc:v1:…`) and legacy plaintext. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored // legacy/plaintext value
  const key = masterKey()
  if (!key) throw new Error('encrypted secret found but SECRET_ENCRYPTION_KEY is not set')
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}
