import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { isCompact } from './compact'
import { decideContextMenu, type ContextMenuDecision } from './contextMenu'
import { MarkdownBlock } from './MarkdownBlock'
import { looksLikeMarkdown } from './markdown'
import { splitSegments, textOffsetBefore } from './markText'
import type { Annotation, AnnotationRange, JsonPath } from '../../shared/types'
import { pathKey } from '../../shared/annotationPath'

/** Strings longer than this are truncated until the reader asks for the rest. */
const LONG_STRING = 5000

/**
 * What the tree needs to render annotations: every annotation recorded for
 * the value or item on screen, and what to do when the reader acts on one.
 * Absent when the tree renders without annotation support.
 */
export type AnnotationView = {
  /** All annotations of the shown value or item (already item-scoped). */
  annotations: Annotation[]
  /** Toggles the annotation at a path, or at an exact span inside it. */
  onToggle: (path: JsonPath, range?: AnnotationRange) => void
}

/** One opened context menu: where it sits and what it decided to offer. */
type MenuState = { x: number; y: number; decision: ContextMenuDecision }

/** Ranges recorded for exactly one value path. */
function rangesFor(path: JsonPath, annotation?: AnnotationView): AnnotationRange[] {
  if (!annotation) return []
  const key = pathKey(path)
  return annotation.annotations
    .filter((a) => a.path !== null && a.range !== undefined && pathKey(a.path) === key)
    .map((a) => a.range!)
}

/** True when a whole-value annotation (error, legacy mark) sits on a path. */
function wholeAnnotated(path: JsonPath, annotation?: AnnotationView): boolean {
  if (!annotation) return false
  const key = pathKey(path)
  return annotation.annotations.some((a) => a.range === undefined && pathKey(a.path) === key)
}

/**
 * Human-readable rendering of any JSON value: objects read as label/value
 * entries, arrays as numbered lists, nested groups get a quiet panel and
 * fold behind a count summary. Leaf-shaped containers — primitive arrays,
 * scalar records, machine-nested grouping — skip the panel and read as a
 * compact inline run instead.
 *
 * Annotating works through the selection context menu: select text inside
 * one value, right-click, and the menu offers copy plus annotate for that
 * exact span; annotated spans show as highlighter marks. Values carry
 * their path in `data-json-path` so the menu can find it.
 */
export function JsonView({
  value,
  annotation,
  defaultExpanded = false
}: {
  value: unknown
  annotation?: AnnotationView
  /** When true, every child group starts unfolded instead of folded. */
  defaultExpanded?: boolean
}): ReactNode {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const handleContextMenu = (event: MouseEvent) => {
    const selection = window.getSelection()
    const selectionText = (selection?.toString() ?? '').trim()
    if (!selection || selection.rangeCount !== 1) return // native menu
    const target = event.target as Element
    const valueEl = target.closest('[data-json-path]')
    // The position (a selection span, or the collapsed caret) must resolve
    // to one character position inside one value.
    let range: AnnotationRange | null = null
    const domRange = selection.getRangeAt(0)
    if (valueEl && valueEl.contains(domRange.startContainer) && valueEl.contains(domRange.endContainer)) {
      range = selectionRangeInElement(valueEl, domRange)
    }
    const decision = decideContextMenu({
      selectionText,
      valueText: valueEl?.textContent ?? null,
      pathText: valueEl?.getAttribute('data-json-path') ?? null,
      withinKey: target.closest('.jv-key, .jv-pair-key, .jv-summary') !== null,
      range,
      hasSelection: selectionText.length > 0,
      annotations: annotation?.annotations ?? []
    })
    if (decision.kind === 'none') return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, decision })
  }

  return (
    <div className="jv" onContextMenu={handleContextMenu}>
      {renderNode(value, [], annotation, defaultExpanded)}
      {menu && <ValueMenu menu={menu} onClose={() => setMenu(null)} onToggle={annotation?.onToggle} />}
    </div>
  )
}

/** The opened menu: copy always, then annotate or remove per the target. */
function ValueMenu({
  menu,
  onClose,
  onToggle
}: {
  menu: MenuState
  onClose: () => void
  onToggle?: (path: JsonPath, range?: AnnotationRange) => void
}): ReactNode {
  const decision = menu.decision
  const items: { label: string; run: () => void }[] = []
  // The menu only opens on a non-none decision, but the type keeps the
  // variant honest: every branch narrows before it touches the payload.
  if (decision.kind !== 'none') {
    items.push({ label: 'Copy', run: () => void navigator.clipboard.writeText(decision.copyText) })
  }
  if (decision.kind === 'copy-annotate' && onToggle) {
    const { path, range } = decision
    items.push({ label: 'Annotate', run: () => onToggle(path, range) })
  }
  if (decision.kind === 'copy-remove' && onToggle) {
    const { path, range } = decision
    items.push({ label: 'Remove annotation', run: () => onToggle(path, range ?? undefined) })
  }
  // Keep the panel on screen when the pointer works near an edge.
  const left = Math.min(menu.x, window.innerWidth - 190)
  const top = Math.min(menu.y, window.innerHeight - 40 * items.length - 12)
  return (
    <div className="jv-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="jv-menu-item"
          onClick={() => {
            item.run()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Maps a DOM selection range onto character offsets in the element's own
 * text. Positions inside a child element (an annotated mark) resolve
 * through the text its earlier siblings contain. Returns null when either
 * edge falls outside the element.
 */
function selectionRangeInElement(el: Element, domRange: Range): AnnotationRange | null {
  const children = Array.from(el.childNodes)
  const childTexts = children.map((c) => c.textContent ?? '')
  const textLength = (node: Node): number => node.textContent?.length ?? 0
  // An element container reports its offset as a child index; translate it
  // into the text length of the children it points past.
  const textBefore = (parent: Node, childIndex: number): number =>
    Array.from(parent.childNodes)
      .slice(0, childIndex)
      .reduce((acc, child) => acc + textLength(child), 0)
  const resolve = (node: Node, offset: number): number | null => {
    if (node === el) return textOffsetBefore(childTexts, offset, 0)
    const index = children.findIndex((c) => c === node || c.contains(node))
    if (index === -1) return null
    const top = children[index]
    let within: number
    if (node === top) {
      within = textBefore(top, offset)
    } else {
      let inner = 0
      let done = false
      const walk = (parent: Node): void => {
        for (const child of Array.from(parent.childNodes)) {
          if (done) return
          if (child === node) {
            within = inner + (node.nodeType === Node.ELEMENT_NODE ? textBefore(node, offset) : offset)
            done = true
            return
          }
          inner += textLength(child)
          walk(child)
        }
      }
      within = 0
      walk(top)
      if (!done) return null
    }
    return textOffsetBefore(childTexts, index, within)
  }
  const start = resolve(domRange.startContainer, domRange.startOffset)
  const end = resolve(domRange.endContainer, domRange.endOffset)
  // A collapsed range is the caret: a valid point annotation position.
  if (start === null || end === null) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

function renderNode(value: unknown, path: JsonPath, annotation?: AnnotationView, defaultExpanded = false): ReactNode {
  if (value === null) return <span className="jv-null" data-json-path={JSON.stringify(path)}>null</span>
  if (typeof value === 'string') return <StringValue text={value} path={path} ranges={rangesFor(path, annotation)} />
  if (typeof value === 'number') return <span className="jv-number" data-json-path={JSON.stringify(path)}>{String(value)}</span>
  if (typeof value === 'boolean') return <span className="jv-boolean" data-json-path={JSON.stringify(path)}>{String(value)}</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty text="Empty array" />
    if (isCompact(value)) return <InlineArray value={value} path={path} annotation={annotation} />
    return (
      <Group kind="array" count={value.length} defaultOpen={defaultExpanded || path.length === 0}>
        <ul className="jv-list">
          {value.map((item, index) => {
            const itemPath: JsonPath = [...path, index]
            const annotated = wholeAnnotated(itemPath, annotation)
            return (
              <li key={index} className={annotated ? 'jv-annotated' : undefined} data-json-path={JSON.stringify(itemPath)}>
                {renderNode(item, itemPath, annotation, defaultExpanded)}
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
    <Group kind="object" count={entries.length} defaultOpen={defaultExpanded || path.length === 0}>
      <div className="jv-fields">
        {entries.map(([key, entryValue]) => {
          const fieldPath: JsonPath = [...path, key]
          const annotated = wholeAnnotated(fieldPath, annotation)
          return (
            <div className={`jv-field${annotated ? ' jv-annotated' : ''}`} key={key}>
              <div className="jv-key">{key === '' ? '""' : key}</div>
              <div className="jv-value" data-json-path={JSON.stringify(fieldPath)}>
                {renderNode(entryValue, fieldPath, annotation, defaultExpanded)}
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
        const annotated = wholeAnnotated(itemPath, annotation)
        return (
          <span key={index} className={`jv-pill${annotated ? ' jv-annotated' : ''}`} data-json-path={JSON.stringify(itemPath)}>
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
        const annotated = wholeAnnotated(fieldPath, annotation)
        const nested = entryValue !== null && typeof entryValue === 'object'
        return (
          <span key={key} className={`jv-pair${annotated ? ' jv-annotated' : ''}`} data-json-path={JSON.stringify(fieldPath)}>
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

/**
 * A string value, with any annotated spans of it shown as highlighter
 * marks. Long strings truncate until expanded; ranges are kept in
 * full-text coordinates and clipped to what is currently visible. Text
 * that reads as markdown carries a small Source ⇄ Preview toggle — the
 * preview replaces the raw run with rendered markdown until toggled back.
 */
function StringValue({ text, path, ranges }: { text: string; path: JsonPath; ranges: AnnotationRange[] }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState(false)
  const markdown = looksLikeMarkdown(text)
  const isLong = text.length > LONG_STRING
  const shown = isLong && !expanded ? `${text.slice(0, LONG_STRING)}…` : text
  const limit = isLong && !expanded ? LONG_STRING : text.length
  const visible = ranges
    .map((r) => ({ start: r.start, end: Math.min(r.end, limit) }))
    .filter((r) => r.start < r.end)
  const segments = splitSegments(shown, visible)
  return (
    <>
      {preview ? (
        <span className="md-value-preview" data-json-path={JSON.stringify(path)}>
          <MarkdownBlock text={text} wrapped />
        </span>
      ) : (
        <span className="jv-string" data-json-path={JSON.stringify(path)}>
          {segments.map((segment, index) =>
            segment.annotated ? (
              <mark key={index} className="jv-mark">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
        </span>
      )}
      {markdown && (
        <button
          type="button"
          className={`jv-md-toggle${preview ? ' on' : ''}`}
          aria-pressed={preview}
          onClick={() => setPreview((on) => !on)}
        >
          {preview ? 'Source' : 'Preview'}
        </button>
      )}
      {isLong && !expanded && !preview && (
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
