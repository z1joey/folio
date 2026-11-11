import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown } from './markdown'

describe('looksLikeMarkdown', () => {
  it('detects headings', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true)
    expect(looksLikeMarkdown('## Section\n\nbody text')).toBe(true)
  })

  it('detects fenced code blocks', () => {
    expect(looksLikeMarkdown('```js\nconst x = 1\n```')).toBe(true)
  })

  it('detects list items at line starts', () => {
    expect(looksLikeMarkdown('- one\n- two')).toBe(true)
    expect(looksLikeMarkdown('1. first\n2. second')).toBe(true)
    expect(looksLikeMarkdown('* starred\n+ plus')).toBe(true)
  })

  it('detects links, bold, tables and quotes', () => {
    expect(looksLikeMarkdown('see [the docs](https://example.com)')).toBe(true)
    expect(looksLikeMarkdown('this is **important** text')).toBe(true)
    expect(looksLikeMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')).toBe(true)
    expect(looksLikeMarkdown('> quoted text')).toBe(true)
  })

  it('accepts multi-line plain text without markdown structure', () => {
    expect(looksLikeMarkdown('a - b')).toBe(false)
    expect(looksLikeMarkdown('a * b * c')).toBe(false)
    expect(looksLikeMarkdown('S.M.A.R.T. goals')).toBe(false)
    expect(looksLikeMarkdown('just a sentence. another sentence.')).toBe(false)
  })

  it('rejects empty and whitespace text', () => {
    expect(looksLikeMarkdown('')).toBe(false)
    expect(looksLikeMarkdown('   \n  ')).toBe(false)
  })
})
