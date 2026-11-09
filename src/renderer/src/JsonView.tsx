import { useState, type ReactNode } from 'react'
import { isCompact } from './compact'
import type { JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/** Strings longer than this are truncated until the reader asks for the rest. */
const LONG_STRING = 5000

/**
 * What the tree needs to render annotations: which locations of the value
 * on screen are annotated, and what to do when the reader presses an
 * annotate control. Absent when the tree renders without annotation support.
 */
export type AnnotationView = {
  /** Path keys (see `pathKey`) of the annotated locations in this value. */
  annotatedKeys: Set<string>
  /** Called with the path of the entry whose control was pressed. */
  onToggle: (path: JsonPath) => void
}

/**
 * Human-readable rendering of any JSON value: objects read as label/value
 * entries, arrays as numbered lists, nested groups get a quiet panel and
 * fold behind a count summary. Leaf-shaped containers — primitive arrays,
 * scalar records, machine-nested grouping — skip the panel and read as a
 * compact inline run instead.
 */
export function JsonView({ value, annotation }: { value: unknown; annotation?: AnnotationView }): ReactNode {
  return <div className="jv">{renderNode(value, [], annotation)}</div>
}

function renderNode(value: unknown, path: JsonPath, annotation?: AnnotationView): ReactNode {
  if (value === null) return <span className="jv-null">null</span>
  if (typeof value === 'string') return <StringValue text={value} />
  if (typeof value === 'number') return <span className="jv-number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="jv-boolean">{String(value)}</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty text="Empty array" />
    if (isCompact(value)) return <InlineArray value={value} path={path} annotation={annotation} />
    return (
      <Group kind="array" count={value.length} defaultOpen={path.length === 0}>
        <ul className="jv-list">
          {value.map((item, index) => {
            const itemPath: JsonPath = [...path, index]
            const annotated = annotation?.annotatedKeys.has(pathKey(itemPath)) ?? false
            return (
              <li key={index} className={annotated ? 'jv-annotated' : undefined}>
                {annotation && <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(itemPath)} />}
                {renderNode(item, itemPath, annotation)}
              </li>
            )
          })}
        </ul>
      </Group>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <Empty text="Empty object" />
  if (isCompact(value)) return <InlineObject entries={entries} path={path} annotation={annotation} />
  return (
    <Group kind="object" count={entries.length} defaultOpen={path.length === 0}>
      <div className="jv-fields">
        {entries.map(([key, entryValue]) => {
          const fieldPath: JsonPath = [...path, key]
          const annotated = annotation?.annotatedKeys.has(pathKey(fieldPath)) ?? false
          return (
            <div className={`jv-field${annotated ? ' jv-annotated' : ''}`} key={key}>
              <div className="jv-key">{key === '' ? '""' : key}</div>
              <div className="jv-value">
                {annotation && <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(fieldPath)} />}
                {renderNode(entryValue, fieldPath, annotation)}
              </div>
            </div>
          )
        })}
      </div>
    </Group>
  )
}

/**
 * How a compact value renders inside the inline run: a scalar goes through
 * the regular scalar rendering, a nested container through its own inline
 * component. Compact subtrees never hold structured groups, so these are
 * the only cases.
 */
function renderInlineValue(value: unknown, path: JsonPath, annotation?: AnnotationView): ReactNode {
  if (value === null || typeof value !== 'object') return renderNode(value, path, annotation)
  if (Array.isArray(value)) return <InlineArray value={value} path={path} annotation={annotation} />
  return <InlineObject entries={Object.entries(value)} path={path} annotation={annotation} />
}

/** An inline array: each item becomes one pill, annotations stay per item. */
function InlineArray({
  value,
  path,
  annotation
}: {
  value: unknown[]
  path: JsonPath
  annotation?: AnnotationView
}): ReactNode {
  return (
    <span className="jv-inline">
      {value.map((item, index) => {
        const itemPath: JsonPath = [...path, index]
        const annotated = annotation?.annotatedKeys.has(pathKey(itemPath)) ?? false
        return (
          <span key={index} className={`jv-pill${annotated ? ' jv-annotated' : ''}`}>
            {annotation && <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(itemPath)} />}
            {renderInlineValue(item, itemPath, annotation)}
          </span>
        )
      })}
    </span>
  )
}

/**
 * An inline object: `key: value` pairs on one flowing line. A pair whose
 * value is itself a container switches its separator to an em-dash so the
 * grouping reads without extra brackets.
 */
function InlineObject({
  entries,
  path,
  annotation
}: {
  entries: [string, unknown][]
  path: JsonPath
  annotation?: AnnotationView
}): ReactNode {
  return (
    <span className="jv-inline">
      {entries.map(([key, entryValue]) => {
        const fieldPath: JsonPath = [...path, key]
        const annotated = annotation?.annotatedKeys.has(pathKey(fieldPath)) ?? false
        const nested = entryValue !== null && typeof entryValue === 'object'
        return (
          <span key={key} className={`jv-pair${annotated ? ' jv-annotated' : ''}`}>
            {annotation && <AnnotateControl annotated={annotated} onToggle={() => annotation.onToggle(fieldPath)} />}
            <span className="jv-pair-key">{key === '' ? '""' : key}</span>
            <span className="jv-pair-sep">{nested ? '—' : ':'}</span>
            {renderInlineValue(entryValue, fieldPath, annotation)}
          </span>
        )
      })}
    </span>
  )
}

/**
 * The per-entry annotate control: appears while the pointer is on the
 * entry's value — never on its key — and stays visible as a ✕ on an
 * already annotated entry.
 */
function AnnotateControl({ annotated, onToggle }: { annotated: boolean; onToggle: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={`annotate-control${annotated ? ' remove' : ''}`}
      title={annotated ? 'Remove annotation' : 'Annotate this value'}
      aria-label={annotated ? 'Remove annotation' : 'Annotate this value'}
      onClick={onToggle}
    >
      {annotated ? '✕' : 'Annotate'}
    </button>
  )
}

/**
 * A foldable object or array: a header button showing the count, then the
 * body only while expanded. The document's root starts open so an item
 * opens as a readable outline of its fields; every child group starts
 * folded and waits for the reader to drill in.
 */
function Group({
  kind,
  count,
  defaultOpen,
  children
}: {
  kind: 'array' | 'object'
  count: number
  defaultOpen: boolean
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  // Label first, count parenthesized after — the header must never read
  // like the list's own numbering right below it.
  const summary = `${kind === 'array' ? 'Items' : 'Entries'} (${count.toLocaleString()})`
  return (
    <div className="jv-group">
      <button type="button" className="jv-summary" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
        {summary}
      </button>
      {open && children}
    </div>
  )
}

function StringValue({ text }: { text: string }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > LONG_STRING
  const shown = isLong && !expanded ? `${text.slice(0, LONG_STRING)}…` : text
  return (
    <>
      <span className="jv-string">{shown}</span>
      {isLong && !expanded && (
        <button className="jv-more" onClick={() => setExpanded(true)}>
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
    </>
  )
}

function Empty({ text }: { text: string }): ReactNode {
  return <span className="jv-empty">{text}</span>
}
