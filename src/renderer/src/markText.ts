import type { AnnotationRange } from '../../shared/types'

/** A run of value text that is either annotated or plain. */
export type TextSegment = { text: string; annotated: boolean }

/**
 * Cuts text into plain and annotated segments for rendering. Ranges may
 * arrive unsorted or degenerate; overlaps are clamped so each character
 * shows at most once.
 */
export function splitSegments(text: string, ranges: AnnotationRange[]): TextSegment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const segments: TextSegment[] = []
  let cursor = 0
  for (const { start, end } of sorted) {
    if (start >= end) continue
    const from = Math.max(start, cursor)
    if (from >= end) continue
    if (from > cursor) segments.push({ text: text.slice(cursor, from), annotated: false })
    segments.push({ text: text.slice(from, end), annotated: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), annotated: false })
  return segments
}

/**
 * The offset of a position `(childIndex, offsetWithin)` inside the
 * concatenated text of a value element's children: everything the earlier
 * children contain, plus the offset within this one.
 */
export function textOffsetBefore(childTexts: readonly string[], childIndex: number, offsetWithin: number): number {
  let before = 0
  for (let i = 0; i < childIndex; i++) before += childTexts[i].length
  return before + offsetWithin
}
