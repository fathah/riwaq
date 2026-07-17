import { describe, expect, it } from 'vitest'
import {
  InvalidProviderApiKeyError,
  normalizeProviderApiKey,
  normalizeStoredProviderApiKey,
} from '../src/lib/provider-api-key'

describe('normalizeProviderApiKey', () => {
  it('keeps a valid provider key unchanged', () => {
    expect(normalizeProviderApiKey('sk-example_123-ABC')).toBe('sk-example_123-ABC')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeProviderApiKey('  sk-example  \n')).toBe('sk-example')
  })

  it.each(['sk-example✓', 'sk-example✓-123', 'sk exam ple', 'sk-example✔'])(
    'rejects a non-header-safe new key: %j',
    (value) => {
      expect(() => normalizeProviderApiKey(value)).toThrow(InvalidProviderApiKeyError)
    },
  )

  it('rejects copied page content', () => {
    expect(() => normalizeProviderApiKey('x'.repeat(513))).toThrow('appears to contain copied page content')
  })
})

describe('normalizeStoredProviderApiKey', () => {
  it('repairs copied whitespace and status symbols in a legacy key', () => {
    expect(normalizeStoredProviderApiKey(' sk-example✓ copied successfully ')).toBe('sk-example')
  })

  it('rejects a legacy value with no valid key bytes', () => {
    expect(() => normalizeStoredProviderApiKey('✓ \n✔')).toThrow(InvalidProviderApiKeyError)
  })

  it('rejects oversized legacy content before trying to repair it', () => {
    expect(() => normalizeStoredProviderApiKey('x'.repeat(513))).toThrow('contains copied page content')
  })
})
