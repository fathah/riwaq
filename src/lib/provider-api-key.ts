export class InvalidProviderApiKeyError extends Error {
  constructor(message = 'API key must contain only printable ASCII characters without spaces. Paste the raw provider key only.') {
    super(message)
    this.name = 'InvalidProviderApiKeyError'
  }
}

/** Validate a newly supplied credential before it is stored. */
export function normalizeProviderApiKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length > 512) {
    throw new InvalidProviderApiKeyError('API key is too long and appears to contain copied page content. Paste only the raw provider key.')
  }
  if (!normalized || !/^[\x21-\x7e]+$/.test(normalized)) {
    throw new InvalidProviderApiKeyError()
  }

  return normalized
}

/**
 * Read credentials saved before strict validation existed. Characters outside
 * visible ASCII cannot be part of an HTTP bearer credential, so dropping them
 * repairs copied whitespace/status markers without guessing at valid key bytes.
 */
export function normalizeStoredProviderApiKey(value: string): string {
  if (value.length > 512) {
    throw new InvalidProviderApiKeyError('Saved API key contains copied page content. Replace it in Settings with only the raw provider key.')
  }
  const copiedMarker = value.indexOf('✓')
  const candidate = copiedMarker >= 0 ? value.slice(0, copiedMarker) : value
  return normalizeProviderApiKey(candidate.replace(/[^\x21-\x7e]/g, ''))
}
