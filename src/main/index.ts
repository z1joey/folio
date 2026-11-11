import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { basename, join } from 'node:path'
import { JsonFile, JsonError, searchText } from './jsonFile'
import { parseRecentFolders, withRecentFolder, type RecentFolder } from './recentFolders'
import {
  annotationFilePathFor,
  annotationIdAtRange,
  byteOffsetAt,
  excerpt,
  isAnnotationFileName,
  lineAt,
  locateValue,
  MAX_ANNOTATION_TARGET_BYTES,
  newAnnotation,
  parseAnnotationRequest,
  queueSidecarWrite,
  readAnnotationList,
  withAnnotation,
  withoutAnnotation,
  writeAnnotationList
} from './annotations'
import type {
  Annotation,
  AnnotationList,
  AnnotationsResponse,
  ItemResponse,
  JsonPath,
  OpenFileResponse,
  OpenResponse,
  SearchHit,
  SearchResponse
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let currentFile: JsonFile | null = null
let currentFileName: string | null = null
// Full path of the file the reader is on — kept even when the file failed to
// open, because an unreadable file is exactly the kind worth annotating.
let currentFilePath: string | null = null
let currentFolderFiles: string[] | null = null
let searchSeq = 0

const FOLDER_SEARCH_LIMIT = 10

/** Markdown previews read whole files; anything past this is refused. */
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024

/**
 * True for loopback, private, link-local and other reserved addresses —
 * the DNS answer a public hostname must never produce before the shell
 * opens a link. (v4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
 * 0/8, 100.64/10; v6: ::1, ::, fc00::/7, fe80::/10, ff00::/8.)
 */
function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if ([a, b, c, d].some((n) => n > 255)) return false
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const v6 = ip.toLowerCase()
  if (v6 === '::1' || v6 === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true
  if (/^ff[0-9a-f]{2}:/.test(v6)) return true
  return false
}

type FolderSearchEntry = { file: JsonFile | null; text: string | null }

// Folder-wide search keeps one entry per file so repeated queries reuse the
// open file (its fd, element ranges, and search memo) instead of re-analyzing
// every file on each keystroke. Entries are dropped — closing any open file
// handles — whenever the folder changes.
const folderSearchCache = new Map<string, FolderSearchEntry>()

async function clearFolderSearchCache(): Promise<void> {
  // Any folder change invalidates folder scans still in flight.
  searchSeq++
  const entries = [...folderSearchCache.values()]
  folderSearchCache.clear()
  await Promise.all(entries.map((entry) => entry.file?.close().catch(() => {})))
}

function createWindow(): void {
  // darwin-only chrome tuning: hiddenInset hides the native bar and the
  // traffic-light position lines them up with the header tools row
  // (52px header, 28px buttons → row center 26px; 12px lights → top 20px).
  const darwin = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#f7f7f9',
    titleBarStyle: darwin ? 'hiddenInset' : 'default',
    ...(darwin ? { trafficLightPosition: { x: 16, y: 20 } } : {}),
    title: 'JSON Reader',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Native macOS fullscreen hides the traffic lights; the renderer gets
  // told so it can reclaim the space they used to reserve.
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('fullscreen-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('fullscreen-changed', false))

  mainWindow.on('closed', () => {
    mainWindow = null
    // A new window starts from a clean slate: drop every folder artifact,
    // including the search cache's open file handles.
    currentFileName = null
    currentFilePath = null
    currentFolderFiles = null
    void closeCurrentFile()
    void clearFolderSearchCache()
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // The renderer is a local, read-only view; it never navigates anywhere
  // and never opens windows of its own.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const requestOpenFolder = (): void => {
    mainWindow?.webContents.send('open-folder-requested')
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: requestOpenFolder },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'copy' }, { role: 'selectAll' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function closeCurrentFile(): Promise<void> {
  if (currentFile) {
    const file = currentFile
    currentFile = null
    await file.close()
  }
}

/**
 * Reads a markdown file as plain text. Markdown files are small by
 * nature; a cap keeps a stray huge file from freezing the renderer.
 */
async function readMarkdownFile(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > MAX_MARKDOWN_BYTES) {
    throw new JsonError('This markdown file is too large to preview.')
  }
  return readFile(path, 'utf8')
}

/** Opens `path` as the current file, replacing whatever was open before. */
async function openJsonFile(path: string): Promise<OpenFileResponse> {
  const fileName = basename(path)
  currentFilePath = path
  try {
    // Markdown files read as plain text — no JSON scan, no annotations.
    if (/\.md$/i.test(fileName)) {
      const text = await readMarkdownFile(path)
      currentFile = null
      currentFileName = fileName
      return { status: 'ok', fileName, root: { type: 'markdown', text } }
    }
    await closeCurrentFile()
    const file = await JsonFile.open(path)
    currentFile = file
    currentFileName = fileName
    return { status: 'ok', fileName, root: file.root }
  } catch (err) {
    currentFile = null
    currentFileName = null
    const message = err instanceof JsonError ? err.message : 'The file could not be read.'
    // The path is kept: a file that fails to open can still be annotated.
    return { status: 'error', fileName, error: message, annotatable: true }
  }
}

/**
 * Opens a folder whose top-level JSON files become the current folder.
 * A single JSON file is opened directly; multiple files get a sidebar.
 */
/**
 * Orders a folder's files for the reading list: plain name order, except
 * that a sidecar annotation file sits directly after the file it belongs
 * to, so a file and its annotations stay adjacent — and no file changes
 * position when a first annotation creates its sidecar mid-session.
 */
export function compareFileWithSidecars(a: string, b: string): number {
  const sortKey = (name: string): string => name.replace(/\.annotations\.json$/i, '.json')
  const byKey = sortKey(a).localeCompare(sortKey(b))
  if (byKey !== 0) return byKey
  const bySidecar = (isAnnotationFileName(a) ? 1 : 0) - (isAnnotationFileName(b) ? 1 : 0)
  return bySidecar || a.localeCompare(b)
}

async function openFolderPath(path: string): Promise<OpenResponse> {
  let names: string[]
  try {
    const entries = await readdir(path, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.(json|md)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareFileWithSidecars)
  } catch {
    currentFilePath = null
    return { status: 'error', fileName: basename(path), error: 'The folder could not be read.' }
  }

  if (names.length === 0) {
    await clearFolderSearchCache()
    await closeCurrentFile()
    currentFileName = null
    currentFilePath = null
    currentFolderFiles = null
    return {
      status: 'error',
      fileName: basename(path),
      error: 'No JSON or Markdown files found in this folder. Please choose another folder.'
    }
  }
  // A successful open puts the folder at the front of the recents.
  await recordRecentFolder(path)
  // A single JSON file behaves like a plain file open: no folder panel.
  if (names.length === 1) {
    await clearFolderSearchCache()
    currentFolderFiles = null
    return openJsonFile(join(path, names[0]))
  }
  await clearFolderSearchCache()
  currentFolderFiles = names.map((name) => join(path, name))
  return { status: 'folder', folderName: basename(path), files: names }
}

async function showAndOpenFolder(win: BrowserWindow): Promise<OpenResponse> {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Open folder',
    properties: ['openDirectory']
  })
  if (picked.canceled || picked.filePaths.length === 0) return { status: 'canceled' }
  return openFolderPath(picked.filePaths[0])
}

/* ── Recently opened folders ────────────────────────────────────────── */

/* A small JSON file in userData: recents are a convenience and must
   never break startup, so every failure reads as "no recents". */
function recentFoldersFile(): string {
  return join(app.getPath('userData'), 'recent-folders.json')
}

async function readRecentFolders(): Promise<RecentFolder[]> {
  try {
    return parseRecentFolders(await readFile(recentFoldersFile(), 'utf8'))
  } catch {
    return []
  }
}

async function writeRecentFolders(folders: RecentFolder[]): Promise<void> {
  await writeFile(recentFoldersFile(), JSON.stringify(folders, null, 2) + '\n', 'utf8')
}

async function recordRecentFolder(path: string): Promise<void> {
  try {
    await writeRecentFolders(withRecentFolder(await readRecentFolders(), path))
  } catch {
    // Unwritable recents are not worth reporting.
  }
}

async function forgetRecentFolder(path: string): Promise<void> {
  try {
    await writeRecentFolders((await readRecentFolders()).filter((folder) => folder.path !== path))
  } catch {
    // Same: not worth reporting.
  }
}

ipcMain.handle('json:open-folder', (): Promise<OpenResponse> => {
  const win = mainWindow
  if (!win) return Promise.resolve({ status: 'canceled' })
  return showAndOpenFolder(win)
})

ipcMain.handle('json:get-recent-folders', (): Promise<RecentFolder[]> => readRecentFolders())

ipcMain.handle('json:open-recent-folder', async (_event, path: unknown): Promise<OpenResponse> => {
  if (typeof path !== 'string' || path.length === 0) return { status: 'canceled' }
  const result = await openFolderPath(path)
  // A recents entry pointing at a vanished or unreadable folder helps no
  // one: drop it so the initial page stays honest.
  if (result.status === 'error' && result.error === 'The folder could not be read.') {
    await forgetRecentFolder(path)
  }
  return result
})

ipcMain.handle('json:open-file', (_event, index: unknown): Promise<OpenFileResponse> => {
  const files = currentFolderFiles
  if (!files || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= files.length) {
    return Promise.resolve({ status: 'error', fileName: '', error: 'No folder is open.' })
  }
  return openJsonFile(files[index])
})

ipcMain.handle('json:get-item', (_event, index: unknown): Promise<ItemResponse> => {
  if (!currentFile || typeof index !== 'number' || !Number.isInteger(index)) {
    return Promise.resolve({ status: 'error', error: 'No file is open.' })
  }
  return currentFile
    .item(index)
    .then((value): ItemResponse => ({ status: 'ok', value }))
    .catch((err: unknown): ItemResponse => ({
      status: 'error',
      error: err instanceof JsonError ? err.message : `Item ${index + 1} could not be read.`
    }))
})

async function searchCurrentFile(query: string, isCanceled: () => boolean): Promise<SearchResponse> {
  // Snapshot the file and its name: a file switch mid-search must neither
  // crash the old scan nor relabel its hits with the new file's name.
  const file = currentFile
  const fileName = currentFileName ?? ''
  if (!file || !file.searchable) return { status: 'unsupported' }
  try {
    const result = await file.search(query, { isCanceled })
    if (result === null) return { status: 'canceled' }
    return {
      status: 'ok',
      hits: result.hits.map((hit) => ({ ...hit, fileIndex: 0, fileName })),
      moreAvailable: result.moreAvailable
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof JsonError ? err.message : 'The search could not be completed.'
    }
  }
}

async function searchFolder(query: string, isCanceled: () => boolean): Promise<SearchResponse> {
  // Snapshot the list: opening another folder while this scan runs replaces
  // currentFolderFiles (possibly with null), and this scan must not follow
  // the switch — its cancellation flag settles it instead.
  const files = currentFolderFiles
  if (!files || files.length === 0) return { status: 'unsupported' }
  const hits: SearchHit[] = []
  let moreAvailable = false

  const addHit = (hit: SearchHit): void => {
    let slot = hits.length
    while (slot > 0 && hits[slot - 1].tier > hit.tier) slot--
    if (hits.length < FOLDER_SEARCH_LIMIT) {
      hits.splice(slot, 0, hit)
    } else if (slot < FOLDER_SEARCH_LIMIT) {
      hits.splice(slot, 0, hit)
      hits.pop()
      moreAvailable = true
    } else {
      moreAvailable = true
    }
  }

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (isCanceled()) return { status: 'canceled' }
    const path = files[fileIndex]
    const fileName = basename(path)

    // Reuse the entry from previous searches so array roots keep their fd,
    // element ranges, and search memo (incremental search), and non-array
    // roots keep their raw text (no second read per query).
    let entry = folderSearchCache.get(path)
    if (!entry) {
      entry = { file: null, text: null }
      folderSearchCache.set(path, entry)
      try {
        const file = await JsonFile.open(path)
        if (file.searchable) entry.file = file
        else await file.close()
      } catch {
        // Unreadable or malformed; the raw-text pass below still gets a shot.
      }
      if (!entry.file) {
        try {
          entry.text = await readFile(path, 'utf8')
        } catch {
          // The file stays in the cache as an empty entry so this folder's
          // searches do not retry opening it on every query.
        }
      }
    }

    try {
      if (entry.file) {
        const result = await entry.file.search(query, { isCanceled })
        if (result === null) return { status: 'canceled' }
        // A single file can hold more matches than the folder cap reports;
        // its flag is the only way those extra matches become visible.
        moreAvailable = moreAvailable || result.moreAvailable
        for (const hit of result.hits) {
          addHit({ ...hit, fileIndex, fileName })
        }
      } else if (entry.text !== null) {
        const found = searchText(entry.text, query)
        if (found) addHit({ ...found, fileIndex, fileName, index: 0 })
      }
    } catch {
      // Skip files that cannot be searched (unreadable, malformed, etc.).
    }
  }

  return { status: 'ok', hits, moreAvailable }
}

ipcMain.handle('json:search', (_event, query: unknown): Promise<SearchResponse> => {
  // Each new request invalidates the previous scan, so fast typing never
  // queues up stale full-file passes.
  const seq = ++searchSeq
  const isCanceled = (): boolean => seq !== searchSeq
  if (typeof query !== 'string') return Promise.resolve({ status: 'error', message: 'Invalid search query.' })
  const search = currentFolderFiles && currentFolderFiles.length > 0
    ? searchFolder(query, isCanceled)
    : searchCurrentFile(query, isCanceled)
  return search
})

ipcMain.handle('json:get-version', (): string => app.getVersion())

/**
 * Opens a markdown link in the system browser. The url must be https and
 * public — localhost, private ranges and other schemes never reach the
 * shell; a refused link just does nothing.
 */
ipcMain.handle('json:open-external', async (_event, url: unknown): Promise<void> => {
  if (typeof url !== 'string') return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return
    if (parsed.username || parsed.password) return
    const addresses = await lookup(parsed.hostname, { all: true }).catch(() => [])
    if (addresses.length > 0 && addresses.every((entry) => isPrivateAddress(entry.address))) return
    await shell.openExternal(parsed.toString())
  } catch {
    // A malformed url is not an error worth surfacing.
  }
})

/** Resolves the annotation target: a folder file by index, or the open single file. */
function annotationTargetPath(fileIndex: number | null): string | null {
  if (fileIndex !== null) {
    const files = currentFolderFiles
    if (!files || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= files.length) return null
    return files[fileIndex]
  }
  return currentFilePath
}

/**
 * Computes where an annotation points in the file: the 1-based line, the
 * absolute byte offset, and a raw excerpt of the annotated value. Returns
 * an error message instead when the location cannot be determined.
 */
async function locateAnnotationTarget(
  sourcePath: string,
  itemIndex: number | null,
  path: JsonPath | null
): Promise<{ line: number | null; byteOffset: number | null; snippet: string | null } | string> {
  if (itemIndex !== null) {
    // The open file already has every element's range; anything else is
    // opened (and closed) just for this lookup.
    const file = currentFile?.filePath === sourcePath ? currentFile : await JsonFile.open(sourcePath).catch(() => null)
    if (!file) return 'The file could not be read.'
    try {
      if (file.root.type !== 'array') return 'The file is not a JSON array.'
      let text: string
      try {
        text = await file.elementText(itemIndex)
      } catch {
        return 'The annotated item does not exist in this file.'
      }
      const range = locateValue(text, path ?? [])
      if (!range) return 'The annotated location does not exist in this file.'
      return {
        line: file.elementStartLine(itemIndex) + lineAt(text, range.start) - 1,
        byteOffset: file.elementStartByte(itemIndex) + byteOffsetAt(text, range.start),
        snippet: excerpt(text.slice(range.start, range.end))
      }
    } finally {
      if (file !== currentFile) await file.close()
    }
  }

  if (path !== null) {
    // A value-root document: locate the path in the file's own text.
    const { size } = await stat(sourcePath).catch(() => ({ size: Infinity }))
    if (size > MAX_ANNOTATION_TARGET_BYTES) return 'This file is too large to annotate.'
    const text = await readFile(sourcePath, 'utf8').catch(() => null)
    if (text === null) return 'The file could not be read.'
    const range = locateValue(text, path)
    if (!range) return 'The annotated location does not exist in this file.'
    return {
      line: lineAt(text, range.start),
      byteOffset: byteOffsetAt(text, range.start),
      snippet: excerpt(text.slice(range.start, range.end))
    }
  }

  // The file (or an unreadable item) as a whole: no finer location exists.
  return { line: null, byteOffset: null, snippet: null }
}

/**
 * Lists a sidecar that was just written in the open folder, right after
 * its source file, so the panel can show it without reopening the folder.
 * Returns the new file names, or null when there is nothing to add (no
 * folder is open, or the sidecar is listed already).
 */
function listNewSidecar(sourcePath: string, sidecarPath: string): string[] | null {
  const files = currentFolderFiles
  if (!files || files.includes(sidecarPath)) return null
  const sourceIndex = files.indexOf(sourcePath)
  if (sourceIndex < 0) return null
  const next = [...files]
  next.splice(sourceIndex + 1, 0, sidecarPath)
  currentFolderFiles = next
  return next.map((file) => basename(file))
}

async function respondWithAnnotations(
  sourcePath: string,
  mutate: (list: AnnotationList) => AnnotationList
): Promise<AnnotationsResponse> {
  const sidecarPath = annotationFilePathFor(sourcePath)
  try {
    const list = await queueSidecarWrite(sidecarPath, async () => {
      const next = mutate(await readAnnotationList(sidecarPath, basename(sourcePath)))
      await writeAnnotationList(sidecarPath, next)
      return next
    })
    return { status: 'ok', annotations: list.annotations, files: listNewSidecar(sourcePath, sidecarPath) ?? undefined }
  } catch {
    return { status: 'error', message: 'The annotation could not be saved.' }
  }
}

ipcMain.handle('json:get-annotations', (_event, fileIndex: unknown): Promise<AnnotationsResponse> => {
  const fields = parseAnnotationRequest({ fileIndex })
  const sourcePath = fields && annotationTargetPath(fields.fileIndex)
  if (!fields || !sourcePath) {
    return Promise.resolve({ status: 'error', message: 'No file is open.' })
  }
  return readAnnotationList(annotationFilePathFor(sourcePath), basename(sourcePath)).then((list) => ({
    status: 'ok' as const,
    annotations: list.annotations
  }))
})

ipcMain.handle('json:add-annotation', async (_event, request: unknown): Promise<AnnotationsResponse> => {
  const fields = parseAnnotationRequest(request)
  const rawMessage = (request as { message?: unknown } | null)?.message
  if (!fields || typeof rawMessage !== 'string') {
    return { status: 'error', message: 'The annotation request is invalid.' }
  }
  const sourcePath = annotationTargetPath(fields.fileIndex)
  if (!sourcePath) return { status: 'error', message: 'No file is open.' }
  const located = await locateAnnotationTarget(sourcePath, fields.itemIndex, fields.path)
  if (typeof located === 'string') return { status: 'error', message: located }
  // An error annotation records the message; a value annotation falls back
  // to the value's own text when the reader sent no note.
  const message = rawMessage.trim() || located.snippet || ''
  if (!message) return { status: 'error', message: 'An annotation needs a message.' }
  const annotation: Annotation = newAnnotation({
    itemIndex: fields.itemIndex,
    path: fields.path,
    ...located,
    message,
    range: fields.range ?? undefined
  })
  return respondWithAnnotations(sourcePath, (list) => withAnnotation(list, annotation))
})

ipcMain.handle('json:remove-annotation', async (_event, request: unknown): Promise<AnnotationsResponse> => {
  const fields = parseAnnotationRequest(request)
  if (!fields) return { status: 'error', message: 'The annotation request is invalid.' }
  const sourcePath = annotationTargetPath(fields.fileIndex)
  if (!sourcePath) return { status: 'error', message: 'No file is open.' }
  return respondWithAnnotations(sourcePath, (list) => {
    const id = annotationIdAtRange(list, fields.itemIndex, fields.path, fields.range)
    return id ? withoutAnnotation(list, id) : list
  })
})

void app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
