import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JsonView } from './JsonView'
import { pathKey } from '../../shared/annotationPath'
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

function render(value: unknown, annotation?: AnnotationView): string {
  return renderToStaticMarkup(createElement(JsonView, { value, annotation }))
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
      expect(markup).toMatch(new RegExp(`jv-key">${key}</div><div class="jv-value"><span class="jv-inline"`))
    }
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

  it('highlights an annotated pill through the unchanged path keys', () => {
    const annotation: AnnotationView = {
      annotatedKeys: new Set([pathKey(['tags', 0])]),
      onToggle: () => {}
    }
    const markup = render(SAMPLE, annotation)
    expect(markup).toMatch(/jv-pill jv-annotated"[^]*?jv-string">gk</)
  })
})
