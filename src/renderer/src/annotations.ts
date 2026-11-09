import type { Annotation, AnnotationRange, JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/**
 * Annotations that belong to the item (or file) currently shown: item
 * annotations carry that item's index, file-level ones use null.
 */
export function annotationsForItem(annotations: Annotation[], itemIndex: number | null): Annotation[] {
  return annotations.filter((annotation) => annotation.itemIndex === itemIndex)
}

/**
 * The set of path keys annotated as whole values (errors, legacy marks):
 * ranged annotations do not count, they highlight only their own span.
 */
export function annotatedKeys(annotations: Annotation[], itemIndex: number | null): Set<string> {
  return new Set(
    annotationsForItem(annotations, itemIndex)
      .filter((annotation) => annotation.range === undefined)
      .map((annotation) => pathKey(annotation.path))
  )
}

/** True when the location already carries a whole-value annotation. */
export function isAnnotated(annotations: Annotation[], itemIndex: number | null, path: JsonPath | null): boolean {
  const key = pathKey(path)
  return annotations.some(
    (annotation) =>
      annotation.itemIndex === itemIndex && annotation.range === undefined && pathKey(annotation.path) === key
  )
}

export type AnnotationToggleDecision = { kind: 'add' } | { kind: 'remove' }

/**
 * Decides what pressing the annotate control at a location must do:
 * annotate an unannotated spot, remove an existing annotation otherwise.
 */
export function decideAnnotationToggle(
  annotations: Annotation[],
  itemIndex: number | null,
  path: JsonPath | null
): AnnotationToggleDecision {
  return isAnnotated(annotations, itemIndex, path) ? { kind: 'remove' } : { kind: 'add' }
}

/**
 * Decides a selection-span toggle: removing requires the exact same span
 * on the same path; any other span adds a new (non-overlapping) mark.
 */
export function decideRangeToggle(
  annotations: Annotation[],
  itemIndex: number | null,
  path: JsonPath,
  range: AnnotationRange
): AnnotationToggleDecision {
  const key = pathKey(path)
  const exists = annotations.some(
    (annotation) =>
      annotation.itemIndex === itemIndex &&
      annotation.path !== null &&
      annotation.range !== undefined &&
      pathKey(annotation.path) === key &&
      annotation.range.start === range.start &&
      annotation.range.end === range.end
  )
  return exists ? { kind: 'remove' } : { kind: 'add' }
}
