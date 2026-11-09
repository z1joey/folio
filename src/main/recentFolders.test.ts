import { describe, expect, it } from 'vitest'
import { parseRecentFolders, withRecentFolder } from './recentFolders'

describe('withRecentFolder', () => {
  it('adds a new folder at the front with its display name', () => {
    const next = withRecentFolder([], '/data/wordlists')
    expect(next).toEqual([{ path: '/data/wordlists', name: 'wordlists', lastOpenedAt: next[0].lastOpenedAt }])
    expect(next[0].lastOpenedAt).toBeTruthy()
  })

  it('moves an already-listed folder back to the front', () => {
    const one = withRecentFolder([], '/a/alpha')
    const two = withRecentFolder(one, '/b/beta')
    expect(two.map((f) => f.name)).toEqual(['beta', 'alpha'])
    const again = withRecentFolder(two, '/a/alpha')
    expect(again.map((f) => f.name)).toEqual(['alpha', 'beta'])
  })

  it('keeps at most three folders, dropping the oldest', () => {
    let list = withRecentFolder([], '/one')
    list = withRecentFolder(list, '/two')
    list = withRecentFolder(list, '/three')
    list = withRecentFolder(list, '/four')
    expect(list.map((f) => f.name)).toEqual(['four', 'three', 'two'])
    // Re-opening a kept folder does not lose it to the cap.
    list = withRecentFolder(list, '/two')
    expect(list.map((f) => f.name)).toEqual(['two', 'four', 'three'])
  })
})

describe('parseRecentFolders', () => {
  it('reads a stored list', () => {
    const text = JSON.stringify([
      { path: '/a/alpha', name: 'alpha', lastOpenedAt: '2026-11-09T10:00:00.000Z' },
      { path: '/b/beta', name: 'beta', lastOpenedAt: '2026-11-09T09:00:00.000Z' }
    ])
    expect(parseRecentFolders(text)).toEqual([
      { path: '/a/alpha', name: 'alpha', lastOpenedAt: '2026-11-09T10:00:00.000Z' },
      { path: '/b/beta', name: 'beta', lastOpenedAt: '2026-11-09T09:00:00.000Z' }
    ])
  })

  it('filters malformed entries and tolerates damaged files', () => {
    const text = JSON.stringify([
      { path: '/a/alpha', name: 'alpha', lastOpenedAt: 'x' },
      { path: 42, name: 'nope', lastOpenedAt: 'x' },
      { name: 'no path' },
      'junk'
    ])
    expect(parseRecentFolders(text)).toEqual([{ path: '/a/alpha', name: 'alpha', lastOpenedAt: 'x' }])
    expect(parseRecentFolders('not json')).toEqual([])
    expect(parseRecentFolders('{}')).toEqual([])
  })
})
