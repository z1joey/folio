import { basename } from 'node:path'
import type { RecentFolder } from '../shared/types'

export type { RecentFolder }

/** The list stays short: the initial page shows at most this many. */
export const RECENT_FOLDERS_MAX = 3

/**
 * Puts a folder at the front of the recents: a known path moves up with a
 * fresh timestamp, a new one is prepended, and the list never grows past
 * `RECENT_FOLDERS_MAX`.
 */
export function withRecentFolder(folders: RecentFolder[], path: string): RecentFolder[] {
  const entry: RecentFolder = { path, name: basename(path), lastOpenedAt: new Date().toISOString() }
  const rest = folders.filter((folder) => folder.path !== path)
  return [entry, ...rest].slice(0, RECENT_FOLDERS_MAX)
}

/**
 * Parses the stored recents file. Malformed entries are dropped, a
 * damaged file yields an empty list — the recents are a convenience and
 * must never break startup.
 */
export function parseRecentFolders(text: string): RecentFolder[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isRecentFolder)
}

function isRecentFolder(value: unknown): value is RecentFolder {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.path === 'string' && typeof r.name === 'string' && typeof r.lastOpenedAt === 'string'
}
