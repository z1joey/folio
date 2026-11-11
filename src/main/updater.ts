import type { net } from 'electron'

/**
 * The download source of truth: the GitHub release of this repository.
 * Only these hosts may ever be contacted, and only over https — the URL
 * comes from the release API response, so every hop is validated against
 * this allowlist before a request goes out.
 */
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])

export type ParsedUpdate = {
  /** Version without the leading `v`, e.g. "0.5.0". */
  version: string
  downloadUrl: string
  /** Expected asset size in bytes, for post-download verification. */
  size: number
}

/** Parses a dotted numeric version into comparable segments, or null. */
function parseVersion(version: string): number[] | null {
  const cleaned = version.startsWith('v') ? version.slice(1) : version
  if (!cleaned) return null
  const segments = cleaned.split('.')
  if (segments.length === 0) return null
  const numbers: number[] = []
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null
    numbers.push(Number(segment))
  }
  return numbers
}

/**
 * True when `candidate` is strictly newer than `current`. Both are dotted
 * numeric versions, an optional leading `v` tolerated; missing segments
 * count as zero (0.4 == 0.4.0). Garbage on either side reads as "not
 * newer" so a broken release can never trigger an update.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(candidate)
  if (!a || !b) return false
  const width = Math.max(a.length, b.length)
  for (let i = 0; i < width; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return right > left
  }
  return false
}

/**
 * Reads the release JSON of `GET /releases/latest` into an update when it
 * is genuinely newer than the running version and carries this build's
 * arm64 dmg asset. Anything malformed, equal or older, or asset-less is
 * null — an update that cannot be described fully is not offered.
 */
export function parseLatestRelease(payload: unknown, currentVersion: string): ParsedUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null
  const release = payload as Record<string, unknown>
  if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return null
  const version = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name
  if (!isNewerVersion(currentVersion, version)) return null
  for (const asset of release.assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const a = asset as Record<string, unknown>
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') continue
    if (!a.name.toLowerCase().endsWith(`-${version}-arm64.dmg`)) continue
    if (!isSafeDownloadUrl(a.browser_download_url)) continue
    return { version, downloadUrl: a.browser_download_url, size: a.size }
  }
  return null
}

/**
 * True for the URLs this updater may ever contact: https, a hostname on
 * the allowlist, no address literals. Redirect targets are re-validated
 * with the same rule before being followed.
 */
export function isSafeDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * True for loopback, private, link-local and other reserved ranges — the
 * addresses a DNS answer must never produce for an allowlisted host.
 * Checked for every resolved address before a byte goes on the wire.
 */
export function isPrivateAddress(ip: string): boolean {
  // IPv4: dotted quad into numeric parts.
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  // IPv6: loopback/any, unique local fc00::/7, link-local fe80::/10,
  // multicast ff00::/8.
  const v6 = ip.toLowerCase()
  if (v6 === '::1' || v6 === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true
  if (/^ff[0-9a-f]{2}:/.test(v6)) return true
  return false
}

/**
 * Guards one hop of a download: the URL must pass the allowlist and every
 * address its host resolves to must be public. The caller aborts on a
 * thrown error, so a poisoned answer never receives a request.
 */
export async function assertResolvablePublicHost(url: string): Promise<void> {
  if (!isSafeDownloadUrl(url)) throw new Error(`Refusing to contact a non-allowlisted url: ${url}`)
  const { hostname } = new URL(url)
  // Address literals were already rejected by the allowlist check; this
  // resolves real names and inspects every answer.
  const { lookup } = await import('node:dns/promises')
  const addresses = await lookup(hostname, { all: true })
  if (addresses.length === 0) throw new Error(`Host resolved to nothing: ${hostname}`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`Host resolved to a private address: ${hostname} -> ${address}`)
  }
}

/**
 * Performs one validated https GET and returns the response stream. Each
 * redirect hop is aborted, re-validated (allowlist + DNS) and re-requested,
 * so the allowlist holds for the whole chain.
 */
export async function requestValidated(netModule: typeof net, url: string, headers: Record<string, string> = {}): Promise<import('electron').IncomingMessage> {
  let target = url
  for (let hops = 0; hops < 5; hops++) {
    await assertResolvablePublicHost(target)
    // eslint-disable-next-line no-await-in-loop -- sequential redirect chain
    const response = await new Promise<import('electron').IncomingMessage>((resolve, reject) => {
      const request = netModule.request({ method: 'GET', url: target, headers: { 'User-Agent': 'json-reader', ...headers } })
      request.on('response', resolve)
      request.on('error', reject)
      request.end()
    })
    if (response.statusCode !== 301 && response.statusCode !== 302 && response.statusCode !== 303 && response.statusCode !== 307 && response.statusCode !== 308) {
      return response
    }
    const location = response.headers.location
    if (!location) return response
    const next = Array.isArray(location) ? location[0] : location
    target = new URL(next, target).toString()
    if (!isSafeDownloadUrl(target)) throw new Error(`Redirect left the allowlist: ${target}`)
  }
  throw new Error('Too many redirects')
}
