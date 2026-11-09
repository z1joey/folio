import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Annotation, AnnotationList, AnnotationRange } from '../shared/types'
import { pathKey } from '../shared/annotationPath'

/** Raw JSON excerpts longer than this are ellipsized in annotations. */
export const EXCERPT_MAX = 200

/**
 * Files whose root is a single value can be re-read for annotation only up
 * to this size — the same cap the reader itself enforces on open.
 */
export const MAX_ANNOTATION_TARGET_BYTES = 256 * 1024 * 1024

/** True for the sidecar files this feature writes next to source files. */
export function isAnnotationFileName(name: string): boolean {
  return /\.annotations\.json$/i.test(name)
}

/** `data.json` lives next to its sidecar `data.annotations.json`. */
export function annotationFilePathFor(sourcePath: string): string {
  return sourcePath.replace(/\.json$/i, '') + '.annotations.json'
}

export function emptyAnnotationList(sourceFileName: string): AnnotationList {
  const now = new Date().toISOString()
  return { version: 1, sourceFile: sourceFileName, createdAt: now, updatedAt: now, annotations: [] }
}

function isObjectKey(segment: unknown): segment is string {
  return typeof segment === 'string'
}

/** Validates one stored annotation; anything malformed is reported as unusable. */
function isValidAnnotation(value: unknown): value is Annotation {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Record<string, unknown>
  if (typeof a.id !== 'string' || a.id.length === 0) return false
  if (a.itemIndex !== null && !isIndex(a.itemIndex)) return false
  if (a.path !== null && !isValidPath(a.path)) return false
  if (a.line !== null && typeof a.line !== 'number') return false
  if (a.byteOffset !== null && typeof a.byteOffset !== 'number') return false
  if (a.snippet !== null && typeof a.snippet !== 'string') return false
  if (typeof a.message !== 'string') return false
  if (a.range !== undefined && !isValidRange(a.range)) return false
  return typeof a.createdAt === 'string'
}

/** A valid selection span: integer offsets with `start` strictly before `end`. */
export function isValidRange(value: unknown): value is AnnotationRange {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    isIndex(r.start) && isIndex(r.end) && r.start < r.end
  )
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isValidPath(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && value.every((segment) => isObjectKey(segment) || isIndex(segment))
}

/**
 * Parses the contents of a sidecar file. Returns null when the text is not
 * a recognizable annotation list — callers then start from a fresh list
 * instead of failing the feature over one damaged file.
 */
export function parseAnnotationList(text: string): AnnotationList | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const doc = parsed as Record<string, unknown>
  if (doc.version !== 1 || typeof doc.sourceFile !== 'string' || !Array.isArray(doc.annotations)) return null
  const annotations = doc.annotations.filter(isValidAnnotation)
  return {
    version: 1,
    sourceFile: doc.sourceFile,
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString(),
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    annotations
  }
}

/** Reads a sidecar file; a missing or damaged file yields a fresh list. */
export async function readAnnotationList(sidecarPath: string, sourceFileName: string): Promise<AnnotationList> {
  try {
    return parseAnnotationList(await readFile(sidecarPath, 'utf8')) ?? emptyAnnotationList(sourceFileName)
  } catch {
    return emptyAnnotationList(sourceFileName)
  }
}

/**
 * Adds an annotation. Semantics depend on its shape:
 *
 * - A ranged annotation (a precise selection) joins its location, but the
 *   ranges on that value stay non-overlapping: existing spans are trimmed
 *   to the parts the new span does not cover, and fully covered ones are
 *   dropped.
 * - A whole-value annotation (errors, legacy marks) replaces every
 *   annotation at the same location, so a location is never recorded twice.
 */
export function withAnnotation(list: AnnotationList, annotation: Annotation): AnnotationList {
  const key = locationKey(annotation.itemIndex, annotation.path)
  const atLocation = list.annotations.filter((a) => locationKey(a.itemIndex, a.path) === key)
  const elsewhere = list.annotations.filter((a) => locationKey(a.itemIndex, a.path) !== key)
  let kept: Annotation[]
  if (annotation.range) {
    const cut = annotation.range
    kept = atLocation.flatMap((a) => {
      if (!a.range) return [a]
      // Each surviving piece keeps the annotation's identity, only the
      // span shrinks to what the new selection does not cover.
      return subtractRange(a.range, cut).map((piece) => ({ ...a, range: piece }))
    })
  } else {
    kept = []
  }
  return { ...list, annotations: [...elsewhere, ...kept, annotation], updatedAt: new Date().toISOString() }
}

/**
 * The part of `existing` that lies outside `cut`: zero pieces when fully
 * covered, one when the cut starts or ends inside, two when the cut falls
 * strictly inside. Non-overlapping ranges pass through untouched.
 */
function subtractRange(existing: AnnotationRange, cut: AnnotationRange): AnnotationRange[] {
  if (existing.end <= cut.start || existing.start >= cut.end) return [existing]
  const left = existing.start < cut.start ? { start: existing.start, end: cut.start } : null
  const right = existing.end > cut.end ? { start: cut.end, end: existing.end } : null
  return left && right ? [left, right] : (left ? [left] : right ? [right] : [])
}

export function withoutAnnotation(list: AnnotationList, id: string): AnnotationList {
  return { ...list, annotations: list.annotations.filter((a) => a.id !== id), updatedAt: new Date().toISOString() }
}

function locationKey(itemIndex: number | null, path: readonly (string | number)[] | null): string {
  return `${itemIndex ?? '*'}|${pathKey(path)}`
}

/** Finds the id of the annotation recorded at a location, if any. */
export function annotationIdAt(
  list: AnnotationList,
  itemIndex: number | null,
  path: readonly (string | number)[] | null
): string | null {
  const key = locationKey(itemIndex, path)
  return list.annotations.find((a) => locationKey(a.itemIndex, a.path) === key)?.id ?? null
}

/**
 * Finds the id of the annotation recorded at a location for one exact
 * span: a range matches only that ranged annotation, a null range matches
 * only the whole-value one. Returns null when nothing matches.
 */
export function annotationIdAtRange(
  list: AnnotationList,
  itemIndex: number | null,
  path: readonly (string | number)[] | null,
  range: AnnotationRange | null
): string | null {
  const key = locationKey(itemIndex, path)
  const match = list.annotations.find(
    (a) =>
      locationKey(a.itemIndex, a.path) === key &&
      ((range === null && a.range === undefined) ||
        (range !== null && a.range !== undefined && a.range.start === range.start && a.range.end === range.end))
  )
  return match?.id ?? null
}

/**
 * Validates the location fields shared by the annotation requests. Returns
 * null when the request shape is wrong; `null` location fields are valid
 * (they mean "the file as a whole").
 */
export function parseAnnotationRequest(request: unknown): {
  fileIndex: number | null
  itemIndex: number | null
  path: (string | number)[] | null
  range: AnnotationRange | null
} | null {
  if (typeof request !== 'object' || request === null) return null
  const r = request as Record<string, unknown>
  const optionalIndex = (value: unknown): number | null | undefined => {
    if (value === null || value === undefined) return null
    return isIndex(value) ? value : undefined
  }
  const fileIndex = optionalIndex(r.fileIndex)
  const itemIndex = optionalIndex(r.itemIndex)
  if (fileIndex === undefined || itemIndex === undefined) return null
  if (r.path !== null && r.path !== undefined && !isValidPath(r.path)) return null
  // An absent or null range marks the whole value; a present one must be
  // a well-formed span, and a malformed one spoils the whole request.
  let range: AnnotationRange | null = null
  if (r.range !== null && r.range !== undefined) {
    if (!isValidRange(r.range)) return null
    range = r.range as AnnotationRange
  }
  return { fileIndex, itemIndex, path: (r.path as (string | number)[] | null) ?? null, range }
}

/**
 * Serializes writes to one sidecar file: read-modify-write cycles are
 * queued per path, so two annotations saved in quick succession cannot
 * silently drop each other.
 */
const sidecarQueues = new Map<string, Promise<unknown>>()

export function queueSidecarWrite<T>(sidecarPath: string, run: () => Promise<T>): Promise<T> {
  const previous = sidecarQueues.get(sidecarPath) ?? Promise.resolve()
  const result = previous.then(run, run)
  sidecarQueues.set(sidecarPath, result)
  void result.catch(() => {}).then(() => {
    if (sidecarQueues.get(sidecarPath) === result) sidecarQueues.delete(sidecarPath)
  })
  return result
}

/** Writes a sidecar file atomically: a crash mid-write keeps the old file. */
export async function writeAnnotationList(sidecarPath: string, list: AnnotationList): Promise<void> {
  const tempPath = `${sidecarPath}.tmp-${randomUUID()}`
  await writeFile(tempPath, JSON.stringify(list, null, 2) + '\n', 'utf8')
  try {
    await rename(tempPath, sidecarPath)
  } catch (err) {
    await rm(tempPath, { force: true })
    throw err
  }
}

export function newAnnotation(fields: {
  itemIndex: number | null
  path: (string | number)[] | null
  line: number | null
  byteOffset: number | null
  snippet: string | null
  message: string
  range?: AnnotationRange
}): Annotation {
  return { id: randomUUID(), createdAt: new Date().toISOString(), ...fields }
}

/**
 * Finds the character range of the value addressed by `path` in raw JSON
 * text, or null when the path does not exist or the text is malformed.
 * An empty path addresses the whole document. The walk reads the text the
 * way a parser would — escape-aware through strings — so brackets and
 * quotes inside string literals never confuse it.
 */
export function locateValue(text: string, path: readonly (string | number)[]): { start: number; end: number } | null {
  let i = skipWhitespace(text, 0)
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (text[i] !== '[') return null
      const start = arrayElementStart(text, i, segment)
      if (start === null) return null
      i = start
    } else {
      if (text[i] !== '{') return null
      const start = objectValueStart(text, i, segment)
      if (start === null) return null
      i = start
    }
  }
  const end = endOfValue(text, i)
  // Every real JSON value spans at least one character; an empty range
  // means the walk landed on nothing (truncated or malformed text).
  return end > i ? { start: i, end } : null
}

function skipWhitespace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Index just past the string literal that opens with a quote at `open`. */
function endOfString(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i + 1
  }
  return text.length
}

/** Index just past the value that starts at `start` (at a value character). */
function endOfValue(text: string, start: number): number {
  const ch = text[start]
  if (ch === '"') return endOfString(text, start)
  if (ch === '{' || ch === '[') {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '"') {
        i = endOfString(text, i) - 1
        continue
      }
      if (text[i] === '{' || text[i] === '[') depth++
      else if (text[i] === '}' || text[i] === ']') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return text.length
  }
  // A primitive runs until whitespace or a structural character ends it.
  let i = start
  while (i < text.length && !/[\s,\]}]/.test(text[i])) i++
  return i
}

/** Start index of the value paired with `key` in the object at `openBrace`. */
function objectValueStart(text: string, openBrace: number, key: string): number | null {
  let i = skipWhitespace(text, openBrace + 1)
  if (text[i] === '}') return null
  for (;;) {
    if (text[i] !== '"') return null
    const keyEnd = endOfString(text, i)
    let parsedKey: unknown
    try {
      parsedKey = JSON.parse(text.slice(i, keyEnd))
    } catch {
      return null
    }
    i = skipWhitespace(text, keyEnd)
    if (text[i] !== ':') return null
    i = skipWhitespace(text, i + 1)
    if (parsedKey === key) return i
    i = skipWhitespace(text, endOfValue(text, i))
    if (text[i] !== ',') return null
    i = skipWhitespace(text, i + 1)
  }
}

/** Start index of the element at `index` in the array at `openBracket`. */
function arrayElementStart(text: string, openBracket: number, index: number): number | null {
  let i = skipWhitespace(text, openBracket + 1)
  if (text[i] === ']') return null
  for (let seen = 0; ; seen++) {
    if (seen === index) return i
    i = skipWhitespace(text, endOfValue(text, i))
    if (text[i] !== ',') return null
    i = skipWhitespace(text, i + 1)
  }
}

/** 1-based line of the character at `index` in `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1
  const stop = Math.min(index, text.length)
  for (let i = 0; i < stop; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** UTF-8 byte offset of the character at `index`, counting multibyte content. */
export function byteOffsetAt(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8')
}

/** A one-line excerpt of raw value text, ellipsized when it runs long. */
export function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > EXCERPT_MAX ? collapsed.slice(0, EXCERPT_MAX) + '…' : collapsed
}
