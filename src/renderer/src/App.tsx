import { useCallback, useEffect, useRef, useState } from 'react'
import type { Annotation, AnnotationRange, JsonPath, OpenFileResponse, OpenResponse, RecentFolder, RootInfo, SearchHit, UpdateState } from '../../shared/types'
import { isOpenableFileName } from '../../shared/fileTypes'
import { jsonReader } from './ipc'
import { annotationsForItem, decideAnnotationToggle, decideRangeToggle, isAnnotated } from './annotations'
import type { AnnotationView } from './JsonView'
import { MarkdownBlock } from './MarkdownBlock'
import FilePanel from './FilePanel'
import ItemPosition from './ItemPosition'
import { JsonView } from './JsonView'
import SearchBar from './SearchBar'
import { decideSearchSelect } from './searchSelect'
type ItemState = { loading: true } | { value: unknown } | { error: string }

type State =
  | { view: 'empty' }
  | { view: 'loading' }
  | { view: 'array'; fileName: string; count: number; index: number; item: ItemState }
  | { view: 'value'; fileName: string; value: unknown }
  | { view: 'markdown'; fileName: string; text: string }
  | { view: 'image'; fileName: string; dataUrl: string }
  | {
      view: 'error'
      fileName: string
      message: string
      /** Set when the error belongs to a file that can be annotated. */
      annotate: { fileIndex: number | null } | null
    }

type FolderState = { name: string; files: string[]; activeIndex: number }

type PendingFolderRequest = { index: number; itemIndex?: number }

/** The annotate control shown on an error state. */
type ErrorAnnotate = { annotated: boolean; onToggle: () => void }

const isMac = navigator.platform.startsWith('Mac')

/** How far `↑`/`↓` scroll the document per key press. */
const CONTENT_SCROLL_STEP = 72

/** Quiet stroke icons for the header tools (lucide-style, no dependency). */
function PanelLeftIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

/** Chevrons spreading apart when expanded, closing in when collapsed. */
function ExpandAllIcon({ up }: { up: boolean }): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? (
        <>
          <path d="M7 4l5 5 5-5" />
          <path d="M7 20l5-5 5 5" />
        </>
      ) : (
        <>
          <path d="M7 9l5-5 5 5" />
          <path d="M7 15l5 5 5-5" />
        </>
      )}
    </svg>
  )
}

function MaximizeIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

function fileNameOf(state: State): string | null {
  if (
    state.view === 'array' ||
    state.view === 'value' ||
    state.view === 'markdown' ||
    state.view === 'image' ||
    state.view === 'error'
  ) {
    return state.fileName
  }
  return null
}

export default function App(): React.ReactElement {
  const [state, setState] = useState<State>({ view: 'empty' })
  const [folder, setFolder] = useState<FolderState | null>(null)
  // Annotations of the file currently shown; loaded when a file opens and
  // updated by every add/remove.
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  // The sidebar is a mouse affordance; the reader can fold it away.
  const [filesHidden, setFilesHidden] = useState(false)
  // Fullscreen reading: the window goes fullscreen and every piece of chrome
  // is removed — the document alone remains, driven by the keyboard.
  const [zen, setZen] = useState(false)
  // Native (system) fullscreen hides the traffic lights, so the header can
  // reclaim the space they reserve in the windowed layout.
  const [osFullscreen, setOsFullscreen] = useState(false)
  useEffect(() => jsonReader.onFullscreenChanged(setOsFullscreen), [])
  // Global fold mode: collapsed shows the document as an outline (root
  // open, children folded); expanded unfolds every child group too.
  const [expandAll, setExpandAll] = useState(false)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void jsonReader.getVersion().then(setVersion)
  }, [])
  // The background update check: once a newer release sits downloaded on
  // disk, the header swaps the version number for an Update button — one
  // slot, one element at a time.
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' })
  // Content-specific tools for the header's right slot: the markdown
  // source toggle and the image zoom percentage.
  const [mdSource, setMdSource] = useState(false)
  const [imageZoom, setImageZoom] = useState(100)
  useEffect(() => {
    void jsonReader.getUpdateState().then(setUpdateState).catch(() => {})
    return jsonReader.onUpdateStateChanged(setUpdateState)
  }, [])
  const stateRef = useRef(state)
  stateRef.current = state
  const zenRef = useRef(zen)
  zenRef.current = zen
  const searchInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // Leaving fullscreen any way (Esc, ⌃⌘F) folds zen mode away with it.
    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement) setZen(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])
  const enterZen = (): void => {
    setZen(true)
    void document.documentElement.requestFullscreen().catch(() => {})
  }
  const exitZen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    setZen(false)
  }
  // A file load is in flight; refs (not state) so rapid clicks read them
  // synchronously instead of waiting for a re-render.
  const loadingRef = useRef(false)
  const loadingFolderIndexRef = useRef<number | null>(null)
  // The latest panel click or search selection made while a load was in flight
  // (last write wins).
  const pendingFolderIndexRef = useRef<PendingFolderRequest | null>(null)

  const refreshAnnotations = useCallback(async (fileIndex: number | null) => {
    const result = await jsonReader.getAnnotations(fileIndex).catch(() => null)
    setAnnotations(result?.status === 'ok' ? result.annotations : [])
  }, [])

  // Folders for the initial page's recent list, most recent first.
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>([])
  const loadRecents = useCallback(async () => {
    const folders = await jsonReader.getRecentFolders().catch(() => [])
    setRecentFolders(folders)
  }, [])

  useEffect(() => {
    void loadRecents()
  }, [loadRecents])

  const applyOpenedFile = useCallback(
    (fileName: string, root: RootInfo, fileIndex: number | null): void => {
      void refreshAnnotations(fileIndex)
      if (root.type === 'array') {
        setState({
          view: 'array',
          fileName,
          count: root.count,
          index: 0,
          item: { loading: true }
        })
      } else if (root.type === 'markdown') {
        setState({ view: 'markdown', fileName, text: root.text })
      } else if (root.type === 'image') {
        setState({ view: 'image', fileName, dataUrl: root.dataUrl })
      } else {
        setState({ view: 'value', fileName, value: root.value })
      }
    },
    [refreshAnnotations]
  )

  const loadFolderFile = useCallback(
    async (index: number, itemIndex?: number) => {
      loadingRef.current = true
      loadingFolderIndexRef.current = index
      setFolder((prev) => (prev ? { ...prev, activeIndex: index } : prev))
      setState({ view: 'loading' })
      const result = await jsonReader.openFile(index)
      if (result.status === 'ok') {
        if (itemIndex !== undefined && result.root.type === 'array' && itemIndex >= 0 && itemIndex < result.root.count) {
          setState({
            view: 'array',
            fileName: result.fileName,
            count: result.root.count,
            index: itemIndex,
            item: { loading: true }
          })
          void refreshAnnotations(index)
        } else {
          applyOpenedFile(result.fileName, result.root, index)
        }
      } else {
        setState({ view: 'error', fileName: result.fileName, message: result.error, annotate: { fileIndex: index } })
        void refreshAnnotations(index)
      }
      // Last write wins: if another panel click arrived while this file was
      // opening, load it now instead of dropping it.
      loadingFolderIndexRef.current = null
      loadingRef.current = false
      const pending = pendingFolderIndexRef.current
      pendingFolderIndexRef.current = null
      if (pending !== null) void loadFolderFile(pending.index, pending.itemIndex)
    },
    [applyOpenedFile, refreshAnnotations]
  )

  // Files macOS hands over (double-click, "Open With"): the main process
  // opened them already; here the renderer just adopts the result. A file
  // open replaces the whole view — it is not a folder pick.
  const adoptOpened = useCallback(
    (result: OpenFileResponse) => {
      pendingFolderIndexRef.current = null
      if (result.status === 'ok') {
        // From the second handoff open on, the result carries a temporary
        // folder and the sidebar lists every file opened this way.
        const { folder } = result
        setFolder(folder ? { name: folder.name, files: folder.files, activeIndex: folder.index } : null)
        applyOpenedFile(result.fileName, result.root, folder ? folder.index : null)
        return
      }
      setFolder(null)
      setState({
        view: 'error',
        fileName: result.fileName,
        message: result.error,
        annotate: result.annotatable ? { fileIndex: null } : null
      })
      void refreshAnnotations(null)
    },
    [applyOpenedFile, refreshAnnotations]
  )

  // The live push works while this renderer is mounted; a file opened at
  // cold launch races that mount, so on start the renderer also pulls
  // (and clears) the result the main process kept for it.
  useEffect(() => {
    void jsonReader
      .consumeFileOpened()
      .then((pending) => {
        if (pending) adoptOpened(pending)
      })
      .catch(() => {})
    return jsonReader.onFileOpened(adoptOpened)
  }, [adoptOpened])

  const openFromFolder = useCallback(
    (index: number, itemIndex?: number) => {
      if (loadingRef.current) {
        // A load is in flight: remember the latest request. Clicking the file
        // that is already loading is a no-op unless a specific item was asked.
        if (loadingFolderIndexRef.current !== index || itemIndex !== undefined) {
          pendingFolderIndexRef.current = { index, itemIndex }
        }
        return
      }
      void loadFolderFile(index, itemIndex)
    },
    [loadFolderFile]
  )

  const handleSearchSelect = useCallback(
    (hit: SearchHit) => {
      const decision = decideSearchSelect(hit, folder, loadingRef.current, stateRef.current.view === 'array')
      if (decision.kind === 'open') {
        openFromFolder(decision.index, decision.itemIndex)
      } else if (decision.kind === 'jump') {
        // A hit for the item already shown must not set loading: the getItem
        // effect keys on the index, so 'loading' would never clear.
        setState((prev) =>
          prev.view === 'array' && decision.itemIndex !== prev.index
            ? { ...prev, index: decision.itemIndex, item: { loading: true } }
            : prev
        )
      }
    },
    [folder, openFromFolder]
  )

  const applyOpenResult = useCallback(
    (result: OpenResponse, before: State) => {
      // A folder open replaces the folder, so a queued panel click can no
      // longer be honored.
      pendingFolderIndexRef.current = null
      if (result.status === 'canceled') {
        loadingRef.current = false
        setState(before)
        return
      }
      if (result.status === 'error') {
        setFolder(null)
        setState({
          view: 'error',
          fileName: result.fileName,
          message: result.error,
          annotate: result.annotatable ? { fileIndex: null } : null
        })
        void refreshAnnotations(null)
        loadingRef.current = false
        return
      }
      void loadRecents()
      if (result.status === 'folder') {
        setFolder({ name: result.folderName, files: result.files, activeIndex: 0 })
        void loadFolderFile(0)
        return
      }
      setFolder(null)
      applyOpenedFile(result.fileName, result.root, null)
      loadingRef.current = false
    },
    [applyOpenedFile, loadFolderFile, loadRecents, refreshAnnotations]
  )

  const pickFolder = useCallback(async () => {
    if (loadingRef.current) return
    const before = stateRef.current
    loadingRef.current = true
    setState({ view: 'loading' })
    const result = await jsonReader.openFolder()
    applyOpenResult(result, before)
  }, [applyOpenResult])

  const openRecentFolder = useCallback(
    async (path: string) => {
      if (loadingRef.current) return
      const before = stateRef.current
      loadingRef.current = true
      setState({ view: 'loading' })
      const result = await jsonReader.openRecentFolder(path)
      applyOpenResult(result, before)
    },
    [applyOpenResult]
  )

  useEffect(() => jsonReader.onOpenFolderRequested(() => void pickFolder()), [pickFolder])

  // Adds an annotation — a whole value, or an exact selection span inside
  // it — or removes the one already recorded there.
  const toggleAnnotation = useCallback(
    async (
      fileIndex: number | null,
      itemIndex: number | null,
      path: JsonPath | null,
      message: string,
      range?: AnnotationRange
    ) => {
      const decision =
        range && path
          ? decideRangeToggle(annotations, itemIndex, path, range)
          : decideAnnotationToggle(annotations, itemIndex, path)
      const request = { fileIndex, itemIndex, path, ...(range ? { range } : {}) }
      const result =
        decision.kind === 'add'
          ? await jsonReader.addAnnotation({ ...request, message }).catch(() => null)
          : await jsonReader.removeAnnotation(request).catch(() => null)
      if (result?.status !== 'ok') return
      setAnnotations(result.annotations)
      // A first annotation creates the file's sidecar; the response carries
      // the grown folder listing so the panel shows it without a reopen.
      if (result.files) setFolder((prev) => (prev ? { ...prev, files: result.files! } : prev))
    },
    [annotations]
  )

  // The whole app is keyboard-driven: no element needs focus for these to work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void pickFolder()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        if (stateRef.current.view === 'array' || folder) {
          event.preventDefault()
          searchInputRef.current?.focus()
        }
        return
      }
      if (event.key === 'Escape') {
        if (zenRef.current) {
          event.preventDefault()
          exitZen()
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Arrow keys typed inside the search field belong to it, not the pager.
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const previous = event.key === 'ArrowLeft' || event.key === 'PageUp'
      const next = event.key === 'ArrowRight' || event.key === 'PageDown'
      const scrollUp = event.key === 'ArrowUp'
      const scrollDown = event.key === 'ArrowDown'
      if (!previous && !next && !scrollUp && !scrollDown) return
      // Files are picked with the mouse (or through search); `↑`/`↓` scroll
      // the document that is on screen.
      if (scrollUp || scrollDown) {
        event.preventDefault()
        contentRef.current?.scrollBy({ top: scrollDown ? CONTENT_SCROLL_STEP : -CONTENT_SCROLL_STEP })
        return
      }
      const current = stateRef.current
      if (current.view !== 'array') return
      event.preventDefault()
      setState((prev) => {
        if (prev.view !== 'array') return prev
        if (previous && prev.index > 0) return { ...prev, index: prev.index - 1, item: { loading: true } }
        if (next && prev.index < prev.count - 1) return { ...prev, index: prev.index + 1, item: { loading: true } }
        return prev
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [folder, pickFolder])

  // Fetch the current item; a stale reply for an older file or index is
  // discarded. The file name is part of the identity: opening another
  // array file that happens to start at the same index must re-fetch.
  const arrayIndex = state.view === 'array' ? state.index : -1
  const arrayFile = state.view === 'array' ? state.fileName : null
  useEffect(() => {
    if (arrayIndex < 0 || arrayFile === null) return
    let alive = true
    jsonReader.getItem(arrayIndex).then((result) => {
      if (!alive) return
      setState((prev) => {
        if (prev.view !== 'array' || prev.index !== arrayIndex || prev.fileName !== arrayFile) return prev
        return { ...prev, item: result.status === 'ok' ? { value: result.value } : { error: result.error } }
      })
    })
    return () => {
      alive = false
    }
  }, [arrayIndex, arrayFile])

  const fileName = fileNameOf(state)
  useEffect(() => {
    document.title = fileName ? `${fileName} — Folio` : 'Folio'
  }, [fileName])

  // Content tools reset with the file: markdown starts in preview, the
  // image zoom returns to actual size.
  useEffect(() => {
    setMdSource(false)
    setImageZoom(100)
  }, [fileName])

  // Dragging .json/.md files onto the window behaves exactly like
  // double-clicking them in Finder: each one opens, accumulates into the
  // session's opened-files list, and the last dropped file is shown.
  const hasFiles = (event: React.DragEvent): boolean => event.dataTransfer.types.includes('Files')
  const onDragOver = (event: React.DragEvent): void => {
    if (hasFiles(event)) event.preventDefault()
  }
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      const paths = Array.from(event.dataTransfer.files)
        .filter((file) => isOpenableFileName(file.name))
        .map((file) => window.jsonReader.pathForFile(file))
        .filter((path) => path.length > 0)
      if (paths.length === 0) return
      void jsonReader
        .openDroppedFiles(paths)
        .then((result) => {
          if (result.status === 'ok') {
            setFolder(result.folder ? { name: result.folder.name, files: result.folder.files, activeIndex: result.folder.index } : null)
            applyOpenedFile(result.fileName, result.root, result.folder ? result.folder.index : null)
            return
          }
          setFolder(null)
          setState({
            view: 'error',
            fileName: result.fileName,
            message: result.error,
            annotate: null
          })
        })
        .catch(() => {})
    },
    [applyOpenedFile]
  )

  // The folder index of the file on screen (null in single-file mode) — the
  // identity annotations are filed under.
  const fileIndex = folder ? folder.activeIndex : null

  const goPrevious = (): void =>
    setState((prev) =>
      prev.view === 'array' && prev.index > 0 ? { ...prev, index: prev.index - 1, item: { loading: true } } : prev
    )
  const goNext = (): void =>
    setState((prev) =>
      prev.view === 'array' && prev.index < prev.count - 1
        ? { ...prev, index: prev.index + 1, item: { loading: true } }
        : prev
    )
  // A jump to the position already shown must not restart the item load:
  // the getItem effect keys on the index, so 'loading' would never clear.
  const jumpTo = (index: number): void =>
    setState((prev) =>
      prev.view === 'array' && index >= 0 && index < prev.count && index !== prev.index
        ? { ...prev, index, item: { loading: true } }
        : prev
    )

  // Annotating an item-level error records that error's message.
  const itemError = state.view === 'array' && 'error' in state.item ? state.item.error : ''

  return (
    <div className={`app${zen ? ' zen' : ''}${osFullscreen ? ' os-fullscreen' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      {(state.view === 'markdown' || state.view === 'image') && (
        <div className="content-tools">
          {state.view === 'markdown' && (
            <button
              type="button"
              className="jv-md-toggle"
              aria-pressed={mdSource}
              onClick={() => setMdSource((on) => !on)}
            >
              {mdSource ? 'Preview' : 'Source'}
            </button>
          )}
          {state.view === 'image' && (
            <>
              <button type="button" className="zoom-button" aria-label="Zoom out" onClick={() => setImageZoom((z) => Math.max(10, z - 25))}>
                −
              </button>
              <span className="zoom-value">{imageZoom}%</span>
              <button type="button" className="zoom-button" aria-label="Zoom in" onClick={() => setImageZoom((z) => Math.min(400, z + 25))}>
                +
              </button>
            </>
          )}
        </div>
      )}
      {!zen && (
        <header className="header">
          {(folder || fileName) && (
            <div className="header-tools">
              {folder && (
                <button
                  type="button"
                  className="icon-button"
                  aria-pressed={!filesHidden}
                  aria-label={filesHidden ? 'Show file list' : 'Hide file list'}
                  title={filesHidden ? 'Show file list' : 'Hide file list'}
                  onClick={() => setFilesHidden((hidden) => !hidden)}
                >
                  <PanelLeftIcon />
                </button>
              )}
              {fileName && (
                <>
                  {/* Expand/collapse shapes a JSON tree; markdown has no
                      tree to fold, so its header only keeps fullscreen. */}
                  {state.view !== 'markdown' && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-pressed={expandAll}
                      aria-label={expandAll ? 'Collapse all sections' : 'Expand all sections'}
                      title={expandAll ? 'Collapse all sections' : 'Expand all sections'}
                      onClick={() => setExpandAll((open) => !open)}
                    >
                      <ExpandAllIcon up={expandAll} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Fullscreen reading"
                    title="Fullscreen reading — no sidebar, no pager; Esc exits"
                    onClick={enterZen}
                  >
                    <MaximizeIcon />
                  </button>
                </>
              )}
            </div>
          )}
          {(folder || (state.view === 'array' && state.count > 0)) && (
            <SearchBar
              key={folder ? `${folder.name}:${folder.files.join(',')}` : state.view === 'array' ? state.fileName : ''}
              inputRef={searchInputRef}
              onSelect={handleSearchSelect}
            />
          )}
          {updateState.kind === 'ready' ? (
      <button
        type="button"
        className="update-button"
        title={`Install v${updateState.version} — downloaded and ready, opens the installer`}
        onClick={() => void jsonReader.installUpdate()}
      >
        Update {updateState.version}
      </button>
    ) : (
      version && <span className="app-version">v{version}</span>
    )}
        </header>
      )}

      <div className="body">
        {folder && !filesHidden && !zen && (
          <FilePanel
            name={folder.name}
            files={folder.files}
            activeIndex={folder.activeIndex}
            onSelect={openFromFolder}
          />
        )}

        <main className="content" ref={contentRef}>
          {state.view === 'empty' && (
            <EmptyState
              onOpenFolder={() => void pickFolder()}
              onOpenRecent={(path) => void openRecentFolder(path)}
              recentFolders={recentFolders}
            />
          )}
          {state.view === 'loading' && (
            <div className="center-state">
              <div className="spinner" />
              <p className="state-text">Loading…</p>
            </div>
          )}
          {state.view === 'error' && (
            <ErrorState
              message={state.message}
              onOpenFolder={folder ? null : () => void pickFolder()}
              annotate={
                state.annotate
                  ? {
                      annotated: isAnnotated(annotations, null, null),
                      onToggle: () => void toggleAnnotation(state.annotate!.fileIndex, null, null, state.message)
                    }
                  : undefined
              }
            />
          )}
          {state.view === 'value' && (
            <div className="doc">
              {/* Keyed by origin + name so each file opens a fresh tree and
                  fold/expand state never leaks from a same-named file in
                  another folder (or a single-file pick). */}
              <JsonView
                key={`${folder?.name ?? 'file'}:${state.fileName}:${expandAll ? 'open' : 'folded'}`}
                value={state.value}
                defaultExpanded={expandAll}
                annotation={{
                  annotations: annotationsForItem(annotations, null),
                  onToggle: (path, range) => void toggleAnnotation(fileIndex, null, path, '', range)
                }}
              />
            </div>
          )}
          {state.view === 'markdown' && (
            <div className="doc">
              {/* Keyed like the value view: a fresh toggle state per file. */}
              <MarkdownView key={`${folder?.name ?? 'file'}:${state.fileName}`} text={state.text} source={mdSource} />
            </div>
          )}
          {state.view === 'image' && (
            <ImageView fileName={state.fileName} dataUrl={state.dataUrl} zoom={imageZoom} />
          )}
          {state.view === 'array' &&
            (state.count === 0 ? (
              <div className="center-state">
                <p className="state-text">This array is empty.</p>
              </div>
            ) : (
              <div className="doc">
                {/* Keyed per origin+file+item for the same reason as the value view. */}
                <ItemBody
                  key={`${folder?.name ?? 'file'}:${state.fileName}:${state.index}:${expandAll ? 'open' : 'folded'}`}
                  item={state.item}
                  defaultExpanded={expandAll}
                  annotationView={{
                    annotations: annotationsForItem(annotations, state.index),
                    onToggle: (path, range) => void toggleAnnotation(fileIndex, state.index, path, '', range)
                  }}
                  errorAnnotate={{
                    annotated: isAnnotated(annotations, state.index, null),
                    onToggle: () => void toggleAnnotation(fileIndex, state.index, null, itemError)
                  }}
                />
              </div>
            ))}
        </main>
      </div>

      {!zen && state.view === 'array' && state.count > 0 && (
        <footer className="footer">
          <button className="button" onClick={goPrevious} disabled={state.index === 0}>
            ← Previous
          </button>
          <ItemPosition index={state.index} count={state.count} onJump={jumpTo} />
          <button className="button" onClick={goNext} disabled={state.index === state.count - 1}>
            Next →
          </button>
        </footer>
      )}
    </div>
  )
}

function ItemBody({
  item,
  defaultExpanded,
  annotationView,
  errorAnnotate
}: {
  item: ItemState
  defaultExpanded: boolean
  annotationView: AnnotationView
  errorAnnotate: ErrorAnnotate
}): React.ReactElement {
  if ('loading' in item) {
    return (
      <div className="center-state">
        <div className="spinner" />
        <p className="state-text">Loading item…</p>
      </div>
    )
  }
  if ('error' in item) {
    return <ErrorState message={item.error} onOpenFolder={null} annotate={errorAnnotate} />
  }
  return <JsonView value={item.value} defaultExpanded={defaultExpanded} annotation={annotationView} />
}

/**
 * A markdown file opened from the sidebar: rendered preview by default,
 * one keystroke away from the raw source. No annotations, no pager — it
 * is not JSON.
 */
/**
 * An image file opened from the sidebar or a drag: centered, contained by
 * the window, at its natural aspect ratio.
 */
function ImageView({
  fileName,
  dataUrl,
  zoom
}: {
  fileName: string
  dataUrl: string
  zoom: number
}): React.ReactElement {
  // Actual-pixel sizing scaled by the zoom percent; the container scrolls
  // when the zoomed image outgrows the window.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const width = natural ? Math.round((natural.w * zoom) / 100) : undefined
  return (
    <div className="image-view">
      <img
        src={dataUrl}
        alt={fileName}
        className="image-view-img"
        style={width ? { width } : undefined}
        onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
      />
    </div>
  )
}

function MarkdownView({ text, source }: { text: string; source: boolean }): React.ReactElement {
  if (source) return <pre className="md-source">{text}</pre>
  return <MarkdownBlock text={text} wrapped />
}

function EmptyState({
  onOpenFolder,
  onOpenRecent,
  recentFolders
}: {
  onOpenFolder: () => void
  onOpenRecent: (path: string) => void
  recentFolders: RecentFolder[]
}): React.ReactElement {
  return (
    <div className="center-state">
      <div className="glyph">{'{ }'}</div>
      <p className="state-text">Open a folder to start reading JSON files</p>
      <button className="button" onClick={onOpenFolder}>
        Open Folder
      </button>
      <p className="hint">
        or press <kbd>{isMac ? '⌘O' : 'Ctrl+O'}</kbd>
      </p>
      {recentFolders.length > 0 && (
        <>
          <p className="recents-label">Recent folders</p>
          <ul className="recent-folders">
            {recentFolders.map((folder) => (
              <li key={folder.path}>
                <button className="recent-folder" title={folder.path} onClick={() => onOpenRecent(folder.path)}>
                  <span className="recent-folder-name">{folder.name}</span>
                  <span className="recent-folder-path">{folder.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ErrorState({
  message,
  onOpenFolder,
  annotate
}: {
  message: string
  onOpenFolder: (() => void) | null
  annotate?: ErrorAnnotate
}): React.ReactElement {
  return (
    <div className="center-state">
      <h2 className="error-title">Unable to read JSON</h2>
      <p className={`error-message${annotate?.annotated ? ' annotated' : ''}`}>{message}</p>
      {(annotate || onOpenFolder) && (
        <div className="error-actions">
          {annotate && (
            <button className="button" onClick={annotate.onToggle}>
              {annotate.annotated ? 'Remove Annotation' : 'Annotate Error'}
            </button>
          )}
          {onOpenFolder && (
            <button className="button" onClick={onOpenFolder}>
              Open Folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}
