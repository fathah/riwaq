import { lookup } from 'node:dns/promises'

// SSRF guard for tenant-supplied URLs (org LLM `baseUrl`). A multi-tenant server
// must never let an authenticated tenant point our egress at internal services
// (cloud metadata, loopback, RFC-1918, link-local…). This is defense the DB and
// route layers can't provide — it lives here, pure and testable.

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

// Injectable resolver so tests exercise the range logic without real DNS.
export type Resolver = (hostname: string) => Promise<string[]>

const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true })
  return records.map((r) => r.address)
}

export type UrlGuardOptions = {
  // Allow http:// (only for local development against plaintext endpoints).
  allowInsecure?: boolean
  // If non-empty, the hostname MUST be one of these (exact, case-insensitive).
  // The strongest control — an explicit provider allowlist. Off by default so
  // "bring your own OpenAI-compatible endpoint" keeps working.
  allowedHosts?: string[]
  resolver?: Resolver
}

/** Expand an IPv4 dotted string to a 32-bit integer, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

// CIDR blocks that must never be reachable from tenant-controlled egress.
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / 255.255.255.255
]

function v4IsBlocked(ip: string): boolean {
  const addr = ipv4ToInt(ip)
  if (addr === null) return true // unparseable → treat as unsafe
  for (const [base, bits] of V4_BLOCKS) {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((addr & mask) === (baseInt & mask)) return true
  }
  return false
}

/** True if an IP literal (v4 or v6) is private, loopback, link-local, or reserved. */
export function isBlockedIp(ip: string): boolean {
  const raw = ip.trim().replace(/^\[|\]$/g, '')
  if (raw.includes('.') && !raw.includes(':')) return v4IsBlocked(raw)

  // IPv6
  const lower = raw.toLowerCase()
  if (lower === '::1' || lower === '::' || lower === '') return true
  // IPv4-mapped/embedded (::ffff:a.b.c.d or ::a.b.c.d) → judge the embedded v4.
  const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (embedded) return v4IsBlocked(embedded[1]!)
  const head = lower.split(':')[0] ?? ''
  if (head.startsWith('fc') || head.startsWith('fd')) return true // fc00::/7 ULA
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb'))
    return true // fe80::/10 link-local
  if (head === 'ff' || lower.startsWith('ff')) return true // multicast
  return false
}

/**
 * Validate a tenant-supplied URL for server-side egress. Rejects non-http(s),
 * embedded credentials, and any host that resolves to a private/reserved IP.
 * Async because it resolves DNS — catching hostnames that point at internal IPs
 * (a DNS-rebinding vector at validation time).
 *
 * @returns the normalized URL string when safe. Throws {@link UnsafeUrlError} otherwise.
 */
export async function assertPublicUrl(raw: string, opts: UrlGuardOptions = {}): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('invalid URL')
  }

  const scheme = url.protocol.toLowerCase()
  if (scheme !== 'https:' && !(scheme === 'http:' && opts.allowInsecure)) {
    throw new UnsafeUrlError(`URL scheme must be https (got ${url.protocol.replace(':', '') || 'none'})`)
  }
  if (url.username || url.password) throw new UnsafeUrlError('URL must not contain embedded credentials')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new UnsafeUrlError('URL has no host')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new UnsafeUrlError('URL host resolves to a local address')

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    if (!opts.allowedHosts.map((h) => h.toLowerCase()).includes(host))
      throw new UnsafeUrlError(`host '${host}' is not in the approved provider allowlist`)
  }

  // Literal IP hosts: check directly. Named hosts: resolve and check every answer.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isBlockedIp(host)) throw new UnsafeUrlError(`URL host '${host}' is a private or reserved address`)
    return url.toString()
  }

  const resolver = opts.resolver ?? defaultResolver
  let addresses: string[]
  try {
    addresses = await resolver(host)
  } catch {
    throw new UnsafeUrlError(`could not resolve host '${host}'`)
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`host '${host}' did not resolve`)
  for (const addr of addresses) {
    if (isBlockedIp(addr))
      throw new UnsafeUrlError(`URL host '${host}' resolves to a private or reserved address (${addr})`)
  }
  return url.toString()
}
