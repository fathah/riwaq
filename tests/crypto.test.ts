import { describe, it, expect, beforeAll } from 'vitest'

// A master key must be set BEFORE importing the crypto module (env is read at load).
beforeAll(() => {
  process.env.SECRET_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
})

describe('secret envelope encryption', () => {
  it('round-trips and produces sealed, non-plaintext ciphertext', async () => {
    const { encryptSecret, decryptSecret, encryptionEnabled } = await import('../src/lib/crypto')
    expect(encryptionEnabled()).toBe(true)

    const secret = 'sk-super-secret-tenant-llm-key'
    const sealed = encryptSecret(secret)
    expect(sealed).toMatch(/^enc:v1:/)
    expect(sealed).not.toContain(secret)
    expect(decryptSecret(sealed)).toBe(secret)
  })

  it('produces distinct ciphertext each time (random IV) but same plaintext', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/lib/crypto')
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  it('passes through legacy plaintext values unchanged', async () => {
    const { decryptSecret } = await import('../src/lib/crypto')
    expect(decryptSecret('legacy-plaintext-key', false)).toBe('legacy-plaintext-key')
    expect(decryptSecret('enc:v1:not-actually-ciphertext', false)).toBe('enc:v1:not-actually-ciphertext')
  })

  it('rejects tampered ciphertext', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/lib/crypto')
    const sealed = encryptSecret('sensitive')
    const tampered = sealed.slice(0, -2) + 'AA'
    expect(() => decryptSecret(tampered, true)).toThrow()
  })
})
