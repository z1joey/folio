import { describe, expect, it } from 'vitest'
import type { Annotation } from '../../shared/types'
import {
  annotatedKeys,
  annotationsForItem,
  decideAnnotationToggle,
  decideRangeToggle,
  isAnnotated
} from './annotations'

function annotation(id: string, itemIndex: number | null, path: (string | number)[] | null): Annotation {
  return {
    id,
    itemIndex,
    path,
    line: 1,
    byteOffset: 0,
    snippet: null,
    message: 'problem',
    createdAt: '2026-09-13T00:00:00.000Z'
  }
}

function ranged(id: string, itemIndex: number | null, path: (string | number)[], start: number, end: number): Annotation {
  return { ...annotation(id, itemIndex, path), range: { start, end } }
}

const stored = [
  annotation('a', 4, ['error']),
  annotation('b', 4, ['tags', 1]),
  annotation('c', 9, ['error']),
  annotation('d', null, ['note'])
]

describe('annotations view logic', () => {
  it('filters annotations down to the item being shown', () => {
    expect(annotationsForItem(stored, 4).map((a) => a.id)).toEqual(['a', 'b'])
    expect(annotationsForItem(stored, 9).map((a) => a.id)).toEqual(['c'])
    // File-level annotations live under null, separate from any item.
    expect(annotationsForItem(stored, null).map((a) => a.id)).toEqual(['d'])
  })

  it('collects the annotated path keys of one item', () => {
    expect(annotatedKeys(stored, 4)).toEqual(new Set(['"error"', '"tags".#1']))
    expect(annotatedKeys(stored, 9)).toEqual(new Set(['"error"']))
    expect(annotatedKeys(stored, 0)).toEqual(new Set())
    // The file-level view keeps its own annotations, keyed by their paths.
    expect(annotatedKeys(stored, null)).toEqual(new Set(['"note"']))
  })

  it('counts only whole-value annotations as annotated keys', () => {
    const mixed = [...stored, ranged('r', 4, ['msg'], 2, 6)]
    // A ranged annotation does not mark the whole value.
    expect(annotatedKeys(mixed, 4)).toEqual(new Set(['"error"', '"tags".#1']))
    expect(isAnnotated(mixed, 4, ['msg'])).toBe(false)
  })

  it('never confuses a numeric string key with an array index', () => {
    const tricky = [annotation('x', 0, ['2']), annotation('y', 0, [2])]
    expect(annotatedKeys(tricky, 0)).toEqual(new Set(['"2"', '#2']))
    expect(isAnnotated(tricky, 0, ['2'])).toBe(true)
    expect(isAnnotated(tricky, 0, [2])).toBe(true)
    expect(isAnnotated(tricky, 0, [3])).toBe(false)
  })

  it('decides add for unannotated locations and remove for annotated ones', () => {
    expect(decideAnnotationToggle(stored, 4, ['error'])).toEqual({ kind: 'remove' })
    expect(decideAnnotationToggle(stored, 4, ['fresh'])).toEqual({ kind: 'add' })
    expect(decideAnnotationToggle(stored, 1, ['error'])).toEqual({ kind: 'add' })
    // The same path under a different item is a different location.
    expect(decideAnnotationToggle(stored, null, ['note'])).toEqual({ kind: 'remove' })
    expect(decideAnnotationToggle(stored, 3, ['note'])).toEqual({ kind: 'add' })
    // A file-level marker (no path at all) is its own location too.
    const fileLevel = [...stored, annotation('e', null, null)]
    expect(decideAnnotationToggle(fileLevel, null, null)).toEqual({ kind: 'remove' })
    expect(decideAnnotationToggle(stored, null, null)).toEqual({ kind: 'add' })
  })

  it('decides the range toggle by exact span match', () => {
    const one = [ranged('r', 4, ['msg'], 2, 6)]
    expect(decideRangeToggle(one, 4, ['msg'], { start: 2, end: 6 })).toEqual({ kind: 'remove' })
    expect(decideRangeToggle(one, 4, ['msg'], { start: 2, end: 5 })).toEqual({ kind: 'add' })
    expect(decideRangeToggle(one, 4, ['msg'], { start: 3, end: 6 })).toEqual({ kind: 'add' })
    expect(decideRangeToggle(one, 9, ['msg'], { start: 2, end: 6 })).toEqual({ kind: 'add' })
    expect(decideRangeToggle(one, 4, ['other'], { start: 2, end: 6 })).toEqual({ kind: 'add' })
    // A whole-value annotation on the same path does not match a range.
    expect(decideRangeToggle([annotation('a', 4, ['msg'])], 4, ['msg'], { start: 2, end: 6 }))
      .toEqual({ kind: 'add' })
  })
})
