import { describe, expect, it } from 'vitest'
import { splitSegments, textOffsetBefore } from './markText'

describe('splitSegments', () => {
  it('returns one plain segment without ranges', () => {
    expect(splitSegments('hello world', [])).toEqual([{ text: 'hello world', annotated: false }])
  })

  it('splits text around one annotated span', () => {
    expect(splitSegments('hello brave world', [{ start: 6, end: 11 }])).toEqual([
      { text: 'hello ', annotated: false },
      { text: 'brave', annotated: true },
      { text: ' world', annotated: false }
    ])
  })

  it('joins adjacent ranges into consecutive annotated segments', () => {
    expect(splitSegments('abcdef', [{ start: 0, end: 2 }, { start: 2, end: 4 }])).toEqual([
      { text: 'ab', annotated: true },
      { text: 'cd', annotated: true },
      { text: 'ef', annotated: false }
    ])
  })

  it('tolerates unsorted and degenerate ranges', () => {
    expect(splitSegments('abcdef', [{ start: 4, end: 6 }, { start: 0, end: 2 }, { start: 3, end: 3 }])).toEqual([
      { text: 'ab', annotated: true },
      { text: 'cd', annotated: false },
      { text: 'ef', annotated: true }
    ])
  })
})

describe('textOffsetBefore', () => {
  it('sums the text of earlier children plus the offset within', () => {
    expect(textOffsetBefore(['abc', 'de'], 1, 1)).toBe(4)
    expect(textOffsetBefore(['abc', 'de'], 0, 2)).toBe(2)
    expect(textOffsetBefore(['abc', 'de'], 2, 0)).toBe(5)
  })
})
