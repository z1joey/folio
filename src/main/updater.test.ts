import { describe, expect, it } from 'vitest'
import { isPrivateAddress, isSafeDownloadUrl, isNewerVersion, parseLatestRelease } from './updater'

describe('isNewerVersion', () => {
  it('accepts a strictly newer version', () => {
    expect(isNewerVersion('0.4.0', '0.5.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '1.0.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(true)
    expect(isNewerVersion('0.9.9', '0.10.0')).toBe(true)
    expect(isNewerVersion('0.4.0', 'v0.5.0')).toBe(true)
  })

  it('rejects equal or older versions', () => {
    expect(isNewerVersion('0.4.0', '0.4.0')).toBe(false)
    expect(isNewerVersion('0.4.0', '0.3.9')).toBe(false)
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(false)
    expect(isNewerVersion('0.4.0', 'v0.4.0')).toBe(false)
  })

  it('compares gracefully across segment counts', () => {
    expect(isNewerVersion('0.4', '0.4.1')).toBe(true)
    expect(isNewerVersion('0.4.1', '0.4')).toBe(false)
    expect(isNewerVersion('1.0', '1.0.0.1')).toBe(true)
  })

  it('rejects garbage versions instead of throwing', () => {
    expect(isNewerVersion('0.4.0', '')).toBe(false)
    expect(isNewerVersion('0.4.0', 'abc')).toBe(false)
    expect(isNewerVersion('0.4.0', '0.4.x')).toBe(false)
    expect(isNewerVersion('dev', '0.5.0')).toBe(false)
  })
})

describe('parseLatestRelease', () => {
  const release = (version: string, assetName: string) => ({
    tag_name: `v${version}`,
    assets: [{ name: assetName, browser_download_url: `https://github.com/z1joey/folio/releases/download/v${version}/${assetName}`, size: 118502975 }]
  })

  it('extracts version, url and size from a newer release', () => {
    const parsed = parseLatestRelease(release('0.5.0', 'folio-0.5.0-arm64.dmg'), '0.4.0')
    expect(parsed).toEqual({
      version: '0.5.0',
      downloadUrl: 'https://github.com/z1joey/folio/releases/download/v0.5.0/folio-0.5.0-arm64.dmg',
      size: 118502975
    })
  })

  it('returns null when the release is not newer than the running version', () => {
    expect(parseLatestRelease(release('0.4.0', 'folio-0.4.0-arm64.dmg'), '0.4.0')).toBeNull()
    expect(parseLatestRelease(release('0.3.9', 'folio-0.3.9-arm64.dmg'), '0.4.0')).toBeNull()
  })

  it('returns null when the arm64 dmg asset is missing', () => {
    expect(parseLatestRelease(release('0.5.0', 'json-reader-0.5.0-x64.dmg'), '0.4.0')).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v0.5.0', assets: [] }, '0.4.0')).toBeNull()
  })

  it('returns null for malformed payloads', () => {
    expect(parseLatestRelease(null, '0.4.0')).toBeNull()
    expect(parseLatestRelease('nope', '0.4.0')).toBeNull()
    expect(parseLatestRelease({}, '0.4.0')).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v0.5.0', assets: 'nope' }, '0.4.0')).toBeNull()
  })
})

describe('isSafeDownloadUrl', () => {
  it('accepts https urls on the allowlisted hosts', () => {
    expect(isSafeDownloadUrl('https://github.com/z1joey/folio/releases/download/v0.5.0/folio-0.5.0-arm64.dmg')).toBe(true)
    expect(isSafeDownloadUrl('https://objects.githubusercontent.com/some/signed/path')).toBe(true)
    expect(isSafeDownloadUrl('https://release-assets.githubusercontent.com/some/path')).toBe(true)
    expect(isSafeDownloadUrl('https://api.github.com/repos/z1joey/folio/releases/latest')).toBe(true)
  })

  it('rejects non-https schemes and non-allowlisted hosts', () => {
    expect(isSafeDownloadUrl('http://github.com/x')).toBe(false)
    expect(isSafeDownloadUrl('ftp://github.com/x')).toBe(false)
    expect(isSafeDownloadUrl('https://evil.example.com/x')).toBe(false)
    // A sibling domain is not the allowlisted host.
    expect(isSafeDownloadUrl('https://api.github.com.evil.com/x')).toBe(false)
    expect(isSafeDownloadUrl('not a url')).toBe(false)
  })

  it('rejects localhost and address-literal hosts', () => {
    expect(isSafeDownloadUrl('https://localhost/x')).toBe(false)
    expect(isSafeDownloadUrl('https://127.0.0.1/x')).toBe(false)
    expect(isSafeDownloadUrl('https://[::1]/x')).toBe(false)
    expect(isSafeDownloadUrl('https://10.0.0.1/x')).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  it('flags private, loopback and reserved IPv4 ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.9')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
    expect(isPrivateAddress('169.254.3.4')).toBe(true)
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
    expect(isPrivateAddress('100.64.0.7')).toBe(true)
  })

  it('flags loopback and private IPv6 ranges', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::')).toBe(true)
    expect(isPrivateAddress('fc00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('ff02::1')).toBe(true)
  })

  it('accepts public addresses', () => {
    expect(isPrivateAddress('140.82.121.4')).toBe(false)
    expect(isPrivateAddress('2606:50c0:8000::9')).toBe(false)
    expect(isPrivateAddress('not-an-ip')).toBe(false)
  })
})
