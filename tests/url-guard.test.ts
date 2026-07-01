import { describe, it, expect } from 'vitest'
import { assertPublicUrl, isBlockedIp, UnsafeUrlError } from '../src/lib/url-guard'

// A resolver stub so these tests never touch real DNS.
const resolvesTo = (ip: string) => async () => [ip]

describe('isBlockedIp', () => {
  const blocked = [
    '127.0.0.1', // loopback
    '10.1.2.3', // RFC1918
    '172.16.0.1', // RFC1918
    '192.168.1.1', // RFC1918
    '169.254.169.254', // cloud metadata (the classic SSRF target)
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1', // IPv6 loopback
    'fd00::1', // IPv6 ULA
    'fe80::1', // IPv6 link-local
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true))
  }

  const allowed = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1::1']
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isBlockedIp(ip)).toBe(false))
  }
})

describe('assertPublicUrl', () => {
  it('rejects non-https by default', async () => {
    await expect(assertPublicUrl('http://api.example.com/v1', { resolver: resolvesTo('93.184.216.34') })).rejects.toThrow(
      UnsafeUrlError,
    )
  })

  it('allows http when allowInsecure is set (dev)', async () => {
    await expect(
      assertPublicUrl('http://api.example.com/v1', { allowInsecure: true, resolver: resolvesTo('93.184.216.34') }),
    ).resolves.toContain('api.example.com')
  })

  it('rejects embedded credentials', async () => {
    await expect(
      assertPublicUrl('https://user:pass@api.example.com', { resolver: resolvesTo('93.184.216.34') }),
    ).rejects.toThrow(/credentials/)
  })

  it('rejects localhost', async () => {
    await expect(assertPublicUrl('https://localhost/v1')).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects a literal metadata IP', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or reserved/)
  })

  it('rejects a hostname that RESOLVES to a private IP (DNS rebinding at validation)', async () => {
    await expect(assertPublicUrl('https://sneaky.example.com', { resolver: resolvesTo('10.0.0.5') })).rejects.toThrow(
      /private or reserved/,
    )
  })

  it('accepts a public https endpoint', async () => {
    await expect(
      assertPublicUrl('https://api.openai.com/v1', { resolver: resolvesTo('104.18.6.192') }),
    ).resolves.toContain('api.openai.com')
  })

  it('enforces an allowlist when provided', async () => {
    await expect(
      assertPublicUrl('https://api.evil.com/v1', {
        allowedHosts: ['api.openai.com'],
        resolver: resolvesTo('104.18.6.192'),
      }),
    ).rejects.toThrow(/allowlist/)
    await expect(
      assertPublicUrl('https://api.openai.com/v1', {
        allowedHosts: ['api.openai.com'],
        resolver: resolvesTo('104.18.6.192'),
      }),
    ).resolves.toContain('api.openai.com')
  })
})
