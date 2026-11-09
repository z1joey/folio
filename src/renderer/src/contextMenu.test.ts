import { describe, expect, it } from 'vitest'
import { decideContextMenu } from './contextMenu'
import type { Annotation } from '../../shared/types'

const ranged = (start: number, end: number): Annotation => ({
  id: 'a-1',
  itemIndex: 0,
  path: ['msg'],
  line: null,
  byteOffset: null,
  snippet: null,
  message: '',
  createdAt: '2026-11-09T10:00:00.000Z',
  range: { start, end }
})

const whole: Annotation = {
  id: 'a-2',
  itemIndex: 0,
  path: ['msg'],
  line: null,
  byteOffset: null,
  snippet: null,
  message: 'flagged',
  createdAt: '2026-11-09T10:00:00.000Z'
}

describe('decideContextMenu', () => {
  it('keeps the native menu when the cursor is not in a value', () => {
    expect(
      decideContextMenu({
        selectionText: '', valueText: null, pathText: null, withinKey: false,
        range: null, hasSelection: false, annotations: []
      })
    ).toEqual({ kind: 'none' })
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello', pathText: '["msg"]', withinKey: true,
        range: { start: 1, end: 1 }, hasSelection: false, annotations: []
      })
    ).toEqual({ kind: 'none' })
  })

  it('keeps the native menu on an unannotated value without a selection', () => {
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello', pathText: '["msg"]', withinKey: false,
        range: { start: 2, end: 2 }, hasSelection: false, annotations: []
      })
    ).toEqual({ kind: 'none' })
  })

  it('offers copy only when a selection spans no single value', () => {
    expect(
      decideContextMenu({
        selectionText: 'crossing', valueText: null, pathText: null, withinKey: false,
        range: null, hasSelection: true, annotations: []
      })
    ).toEqual({ kind: 'copy', copyText: 'crossing' })
    expect(
      decideContextMenu({
        selectionText: 'mixed', valueText: 'hello', pathText: '["msg"]', withinKey: false,
        range: null, hasSelection: true, annotations: []
      })
    ).toEqual({ kind: 'copy', copyText: 'mixed' })
  })

  it('offers annotate for a fresh selection span', () => {
    expect(
      decideContextMenu({
        selectionText: 'brave', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 6, end: 11 }, hasSelection: true, annotations: [ranged(12, 17)]
      })
    ).toEqual({
      kind: 'copy-annotate',
      copyText: 'brave',
      path: ['msg'],
      range: { start: 6, end: 11 }
    })
  })

  it('offers remove for the exact span of an existing range annotation', () => {
    expect(
      decideContextMenu({
        selectionText: 'brave', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 6, end: 11 }, hasSelection: true, annotations: [ranged(6, 11)]
      })
    ).toEqual({
      kind: 'copy-remove',
      copyText: 'brave',
      path: ['msg'],
      range: { start: 6, end: 11 }
    })
  })

  it('offers remove for a whole-value annotation under a selection', () => {
    expect(
      decideContextMenu({
        selectionText: 'hello', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 0, end: 5 }, hasSelection: true, annotations: [whole]
      })
    ).toEqual({ kind: 'copy-remove', copyText: 'hello', path: ['msg'], range: null })
  })

  it('offers remove when the cursor rests inside a range annotation, no selection', () => {
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 8, end: 8 }, hasSelection: false, annotations: [ranged(6, 11)]
      })
    ).toEqual({
      kind: 'copy-remove',
      copyText: 'brave',
      path: ['msg'],
      range: { start: 6, end: 11 }
    })
  })

  it('does not fire removal when the cursor sits outside every span', () => {
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 3, end: 3 }, hasSelection: false, annotations: [ranged(6, 11)]
      })
    ).toEqual({ kind: 'none' })
    // The half-open end boundary is outside too.
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 11, end: 11 }, hasSelection: false, annotations: [ranged(6, 11)]
      })
    ).toEqual({ kind: 'none' })
  })

  it('offers remove on a whole-value annotated value even without a selection', () => {
    expect(
      decideContextMenu({
        selectionText: '', valueText: 'hello brave world', pathText: '["msg"]', withinKey: false,
        range: { start: 4, end: 4 }, hasSelection: false, annotations: [whole]
      })
    ).toEqual({ kind: 'copy-remove', copyText: 'hello brave world', path: ['msg'], range: null })
  })

  it('rejects path text that does not parse as a JSON path', () => {
    expect(
      decideContextMenu({
        selectionText: 'x', valueText: 'x', pathText: 'not json', withinKey: false,
        range: { start: 0, end: 1 }, hasSelection: true, annotations: []
      })
    ).toEqual({ kind: 'copy', copyText: 'x' })
  })
})
