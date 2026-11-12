import { describe, expect, it } from 'vitest'
import { isOpenableFileName, mimeForExt } from './fileTypes'

describe('isOpenableFileName', () => {
  it('accepts json, markdown and image extensions', () => {
    for (const name of ['a.json', 'A.JSON', 'readme.md', 'notes.MD', 'logo.png', 'photo.JPG', 'pic.jpeg', 'anim.gif', 'modern.webp', 'vector.svg', 'bitmap.bmp']) {
      expect(isOpenableFileName(name)).toBe(true)
    }
  })

  it('rejects other extensions and extension-less names', () => {
    for (const name of ['notes.txt', 'archive.zip', 'noext', '.hidden.json']) {
      expect(isOpenableFileName(name)).toBe(name === '.hidden.json')
    }
  })
})

describe('mimeForExt', () => {
  it('maps image extensions to mime types, case-insensitively', () => {
    expect(mimeForExt('png')).toBe('image/png')
    expect(mimeForExt('JPG')).toBe('image/jpeg')
    expect(mimeForExt('svg')).toBe('image/svg+xml')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeForExt('zzz')).toBe('application/octet-stream')
  })
})
