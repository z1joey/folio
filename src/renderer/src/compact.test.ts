import { describe, expect, it } from 'vitest'
import { isCompact } from './compact'

describe('isCompact', () => {
  it('treats every primitive as compact', () => {
    expect(isCompact('hello')).toBe(true)
    expect(isCompact(1793901217)).toBe(true)
    expect(isCompact(true)).toBe(true)
    expect(isCompact(null)).toBe(true)
  })

  it('treats empty containers as compact', () => {
    expect(isCompact([])).toBe(true)
    expect(isCompact({})).toBe(true)
  })

  it('compacts arrays of primitives', () => {
    expect(isCompact(['gk', 'zk'])).toBe(true)
    expect(isCompact(['hi', 'howdy', 'hullo'])).toBe(true)
    expect(isCompact([1, 2, 3])).toBe(true)
  })

  it('compacts scalar-only objects', () => {
    expect(isCompact({ provider: 'zcode/GLM', updatedAt: 1793901217 })).toBe(true)
    expect(isCompact({ plural: 'helloes' })).toBe(true)
  })

  it('compacts objects that purely group compact values', () => {
    // {us: {ipa}} — an object of objects, no scalars beside them.
    expect(isCompact({ us: { ipa: 'həˈlo' }, uk: { ipa: 'həˈləʊ' } })).toBe(true)
    // highlight — an object of compact arrays.
    expect(isCompact({ en: [[{ start: 36, end: 42, text: 'hellos' }]] })).toBe(true)
  })

  it('compacts arrays of scalar-only records and nested arrays of them', () => {
    expect(isCompact([{ start: 36, end: 42, text: 'hellos' }])).toBe(true)
    expect(isCompact([[{ start: 36, end: 42, text: 'hellos' }]])).toBe(true)
  })

  it('refuses records that mix primitives with containers', () => {
    // A reading record: {en, cn, examples} must keep its structured card.
    expect(isCompact({ en: 'say hello to', cn: '向…问好', examples: [{ en: 'a' }] })).toBe(false)
    // So an array of such records stays structured too.
    expect(isCompact([{ en: 'a', examples: [] }])).toBe(false)
  })

  it('refuses containers holding a non-compact value', () => {
    expect(isCompact({ us: { ipa: 'həˈlo' }, fr: { ipa: 'həˈlo', note: ['a', { b: 1 }] } })).toBe(false)
    expect(isCompact([[{ start: 1, end: 2 }, { start: 3, end: 4, text: ['x', { y: 'z' }] }]])).toBe(false)
  })

  it('refuses containers larger than the fold threshold', () => {
    const many = Array.from({ length: 21 }, (_, i) => String(i))
    expect(isCompact(many)).toBe(false)
    const wide = Object.fromEntries(many.map((k) => [k, k]))
    expect(isCompact(wide)).toBe(false)
  })

  it('refuses the document skeleton of the sample word entry', () => {
    // word is a primitive while metadata…phrases are containers: the mix
    // must keep the top level structured.
    const sample = {
      word: 'hello',
      metadata: { provider: 'zcode/GLM-5.3-Flash', updatedAt: 1793901217 },
      tags: ['gk', 'zk'],
      entries: [{ partOfSpeech: 'noun', senses: [] }],
      phrases: []
    }
    expect(isCompact(sample)).toBe(false)
  })
})
