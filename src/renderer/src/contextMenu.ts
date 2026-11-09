import type { Annotation, AnnotationRange, JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/**
 * What a right-click should offer:
 *
 * - `none`: no selection and nothing annotated under the cursor — leave
 *   the native menu in place;
 * - `copy`: a selection that is not a span inside one value (crossing two
 *   values, or unresolvable) — copy is the only sensible action;
 * - `copy-annotate`: a fresh selection inside one value's text — copy
 *   plus record an annotation for that exact span;
 * - `copy-remove`: the target already carries an annotation — the exact
 *   selected span, the span the cursor rests in, or the whole value —
 *   copy plus remove it.
 */
export type ContextMenuDecision =
  | { kind: 'none' }
  | { kind: 'copy'; copyText: string }
  | { kind: 'copy-annotate'; copyText: string; path: JsonPath; range: AnnotationRange }
  | { kind: 'copy-remove'; copyText: string; path: JsonPath; range: AnnotationRange | null }

/** Input gathered from the DOM by the caller; kept plain for tests. */
export type ContextMenuInput = {
  /** The selected text; whitespace-only counts as no selection. */
  selectionText: string
  /** Full text of the value element under the cursor, if any. */
  valueText: string | null
  /** JSON text of the value path under the cursor, if any. */
  pathText: string | null
  /** True when the cursor sits in a key or a fold header (defence). */
  withinKey: boolean
  /**
   * The selection's character span inside the value, or the collapsed
   * cursor point (`start === end`) when nothing is selected. Null when
   * the position does not resolve to one value.
   */
  range: AnnotationRange | null
  hasSelection: boolean
  /** All annotations recorded for the value or item being shown. */
  annotations: Annotation[]
}

/** Values parse their stored path lazily; bad data degrades to copy-only. */
function parsePath(pathText: string): JsonPath | null {
  try {
    const parsed: unknown = JSON.parse(pathText)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((segment) => typeof segment === 'string' || typeof segment === 'number') as JsonPath
  } catch {
    return null
  }
}

export function decideContextMenu(input: ContextMenuInput): ContextMenuDecision {
  if (!input.hasSelection) {
    // Without a selection only annotated content opens the custom menu.
    if (input.withinKey || input.valueText === null || input.pathText === null || input.range === null) {
      return { kind: 'none' }
    }
    const valueText = input.valueText
    const path = parsePath(input.pathText)
    if (path === null) return { kind: 'none' }
    const key = pathKey(path)
    const atPath = input.annotations.filter((a) => a.path !== null && pathKey(a.path) === key)
    const offset = input.range.start
    const covering = atPath.find((a) => a.range !== undefined && a.range.start <= offset && offset < a.range.end)
    if (covering?.range) {
      return {
        kind: 'copy-remove',
        copyText: valueText.slice(covering.range.start, covering.range.end),
        path,
        range: covering.range
      }
    }
    if (atPath.some((a) => a.range === undefined)) {
      return { kind: 'copy-remove', copyText: valueText, path, range: null }
    }
    return { kind: 'none' }
  }
  // With a selection: copy is always on the menu, the second item depends
  // on what the span hits.
  if (input.withinKey || input.valueText === null || input.pathText === null || input.range === null) {
    return { kind: 'copy', copyText: input.selectionText }
  }
  const path = parsePath(input.pathText)
  if (path === null) return { kind: 'copy', copyText: input.selectionText }
  const key = pathKey(path)
  const atPath = input.annotations.filter((a) => a.path !== null && pathKey(a.path) === key)
  if (atPath.some((a) => a.range === undefined)) {
    return { kind: 'copy-remove', copyText: input.selectionText, path, range: null }
  }
  const exact = atPath.find(
    (a) =>
      a.range !== undefined &&
      a.range.start === input.range!.start &&
      a.range.end === input.range!.end
  )
  if (exact?.range) {
    return { kind: 'copy-remove', copyText: input.selectionText, path, range: exact.range }
  }
  return { kind: 'copy-annotate', copyText: input.selectionText, path, range: input.range }
}
