import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JsonView } from './JsonView'
import type { Annotation } from '../../shared/types'
import type { AnnotationView } from './JsonView'

const SAMPLE = {
  word: 'hello',
  metadata: {
    provider: 'zcode/GLM-5.3-Flash',
    updatedAt: 1793901217
  },
  pronunciation: {
    us: { ipa: 'həˈlo' },
    uk: { ipa: 'həˈləʊ' }
  },
  forms: {
    plural: 'helloes'
  },
  tags: ['gk', 'zk'],
  synonyms: ['hi', 'howdy', 'hullo'],
  entries: [
    {
      partOfSpeech: 'noun',
      senses: [
        {
          id: 'hello-noun-1',
          en: 'an expression of greeting',
          cn: '问候',
          examples: [
            {
              en: 'Every morning they exchanged polite hellos.',
              cn: '每天早上他们互致礼貌的问候。',
              highlight: {
                en: [[{ start: 36, end: 42, text: 'hellos' }]],
                cn: [[{ start: 11, end: 13, text: '问候' }]]
              }
            }
          ]
        }
      ]
    }
  ],
  phrases: [
    {
      en: 'say hello to',
      cn: '向…问好',
      examples: [
        {
          en: 'Please say hello to your mother for me when you call tonight.',
          cn: '今晚打电话时请代我向你母亲问好。',
          highlight: {
            en: [[{ start: 7, end: 19, text: 'say hello to' }]],
            cn: [[{ start: 13, end: 15, text: '问好' }]]
          }
        }
      ]
    },
    {
      en: 'wave hello',
      cn: '挥手致意',
      examples: [
        {
          en: 'The children wave hello to the bus driver every morning.',
          cn: '孩子们每天早上向公交车司机挥手致意。',
          highlight: {
            en: [[{ start: 13, end: 23, text: 'wave hello' }]],
            cn: [[{ start: 13, end: 17, text: '挥手致意' }]]
          }
        }
      ]
    },
    {
      en: 'hello and welcome',
      cn: '欢迎致意',
      examples: [
        {
          en: 'The host opened the ceremony with a warm hello and welcome.',
          cn: '主持人以热情的欢迎致意拉开了典礼的序幕。',
          highlight: {
            en: [[{ start: 41, end: 58, text: 'hello and welcome' }]],
            cn: [[{ start: 7, end: 11, text: '欢迎致意' }]]
          }
        }
      ]
    }
  ]
}

function render(value: unknown, annotation?: AnnotationView, defaultExpanded?: boolean): string {
  return renderToStaticMarkup(createElement(JsonView, { value, annotation, defaultExpanded }))
}

describe('JsonView shape-adaptive rendering', () => {
  it('renders primitive arrays as inline pills', () => {
    const markup = render(SAMPLE)
    expect(markup).toContain('jv-pill')
    expect(markup).toContain('>gk<')
    expect(markup).toContain('>zk<')
    expect(markup).toContain('>howdy<')
  })

  it('renders scalar-only objects as inline pairs, without a count header', () => {
    const markup = render(SAMPLE)
    expect(markup).toContain('jv-pair')
    expect(markup).toContain('>updatedAt<')
    expect(markup).toContain('>provider<')
    expect(markup).toContain('>plural<')
    // metadata/forms/pronunciation must not grow fold headers: each key is
    // followed by an inline run, not a group.
    for (const key of ['metadata', 'pronunciation', 'forms']) {
      expect(markup).toMatch(new RegExp(`jv-key">${key}</div><div class="jv-value"[^>]*><span class="jv-inline"`))
    }
  })

  it('tags values with their path for the context menu, keys never', () => {
    const markup = render(SAMPLE)
    expect(markup).toContain('data-json-path="[')
    // Field keys and pair keys carry no path attribute.
    expect(markup).not.toMatch(/jv-key"[^>]*data-json-path/)
    expect(markup).not.toMatch(/jv-pair-key"[^>]*data-json-path/)
  })

  it('compacts the machine-shaped highlight nesting into pills', () => {
    // Render one example as the root so nothing sits behind a fold.
    const markup = render({
      en: 'Every morning they exchanged polite hellos.',
      cn: '每天早上他们互致礼貌的问候。',
      highlight: {
        en: [[{ start: 36, end: 42, text: 'hellos' }]],
        cn: [[{ start: 11, end: 13, text: '问候' }]]
      }
    })
    expect(markup).toContain('>start<')
    expect(markup).toContain('>hellos<')
    // en and cn each contribute an outer + inner pill around their ranges.
    expect(markup.match(/jv-pill/g)?.length).toBe(4)
  })

  it('keeps the reading records structured', () => {
    // The phrases array as root: expanded, so each record's header shows.
    const markup = render(SAMPLE.phrases)
    expect(markup.match(/Entries \(3\)/g)?.length).toBe(3)
    // Record bodies wait behind their folded headers; only the root's own
    // numbered list shows.
    expect(markup).not.toContain('say hello to')
    expect(markup.match(/jv-list/g)?.length).toBe(1)
  })

  it('expands the root group but collapses every child by default', () => {
    const markup = render(SAMPLE)
    // Root object shows its fields…
    expect(markup).toMatch(/aria-expanded="true"/)
    // …while the structured children (entries, phrases) wait folded.
    expect(markup.match(/aria-expanded="false"/g)?.length).toBe(2)
    expect(markup).toContain('aria-expanded="false">Items (1)')
    expect(markup).toContain('aria-expanded="false">Items (3)')
    expect(markup).not.toContain('jv-list')
    expect(markup).not.toContain('>partOfSpeech<')
  })

  it('expands every child group in expanded mode', () => {
    const markup = render(SAMPLE, undefined, true)
    expect(markup.match(/aria-expanded="false"/g)?.length ?? 0).toBe(0)
    // The folded content is actually present now.
    expect(markup).toContain('jv-list')
    expect(markup).toContain('>partOfSpeech<')
    expect(markup).toContain('say hello to')
  })

  it('highlights a whole-value annotation through the unchanged path keys', () => {
    const annotation: AnnotationView = {
      annotations: [{ ...baseAnnotation('tags-pill'), path: ['tags', 0] }],
      onToggle: () => {}
    }
    const markup = render(SAMPLE, annotation)
    // Exactly one annotated pill — the gk one — with no annotation buttons
    // anywhere: removal lives in the selection context menu.
    expect(markup.match(/jv-pill jv-annotated/g)?.length).toBe(1)
    expect(markup).not.toContain('annotate-control')
  })

  it('marks exactly the annotated span inside a string value', () => {
    const annotation: AnnotationView = {
      annotations: [{ ...baseAnnotation('sense-en'), path: ['msg'], range: { start: 6, end: 11 } }],
      onToggle: () => {}
    }
    const markup = render({ msg: 'hello brave world' }, annotation)
    expect(markup).toMatch(/<mark class="jv-mark">brave<\/mark>/)
    // The ✕ belongs to whole-value annotations only; ranges remove via menu.
    expect(markup).not.toContain('annotate-control')
  })

  it('clips string ranges to the truncated text of long values', () => {
    const long = 'x'.repeat(6000)
    const annotation: AnnotationView = {
      annotations: [{ ...baseAnnotation('long'), path: ['log'], range: { start: 5990, end: 6000 } }],
      onToggle: () => {}
    }
    const markup = render({ log: long }, annotation)
    // The range sits past the truncation point, so nothing is marked yet.
    expect(markup).not.toContain('jv-mark')
  })
})

function baseAnnotation(id: string): Annotation {
  return {
    id,
    itemIndex: null,
    path: null,
    line: null,
    byteOffset: null,
    snippet: null,
    message: '',
    createdAt: '2026-11-09T10:00:00.000Z'
  }
}
