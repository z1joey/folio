import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AnnotationsResponse, OpenFileResponse, OpenResponse, RecentFolder, SearchResponse } from '../shared/types'

// Electron is replaced wholesale: only the pieces index.ts touches exist,
// and the dialog is driven by each test. The file system stays real, so
// folder scanning and JSON opening run against actual temp directories.
const { appMock, browserWindowMock, dialogMock, ipcMainMock, menuMock } = vi.hoisted(() => ({
  // getPath is exercised at handler runtime, long after `dir` exists.
  appMock: {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
    getPath: vi.fn(() => join(dir, 'userdata'))
  },
  // A `function` implementation so `new BrowserWindow(...)` works and
  // returns this window object (constructors keep an explicit return value).
  browserWindowMock: vi.fn(function () {
    return {
      on: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      webContents: { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() }
    }
  }),
  dialogMock: { showOpenDialog: vi.fn() },
  ipcMainMock: { handle: vi.fn() },
  menuMock: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() }
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  dialog: dialogMock,
  ipcMain: ipcMainMock,
  Menu: menuMock,
  nativeTheme: {}
}))

let dir: string
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

beforeAll(async () => {
  vi.stubGlobal('__dirname', process.cwd())
  dir = await mkdtemp(join(tmpdir(), 'json-reader-main-'))
  await mkdir(join(dir, 'userdata'), { recursive: true })
  await import('./index')
  // The module wires the menu and the window once app.whenReady() settles.
  await vi.waitFor(() => expect(browserWindowMock).toHaveBeenCalled())
  for (const call of ipcMainMock.handle.mock.calls) {
    handlers.set(call[0] as string, call[1] as (...args: unknown[]) => Promise<unknown>)
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

beforeEach(() => {
  dialogMock.showOpenDialog.mockReset()
})

async function folderFixture(name: string, files: Record<string, string>): Promise<string> {
  const folder = join(dir, name)
  await mkdir(folder)
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(folder, file), content, 'utf8')
  }
  return folder
}

function pick(...filePaths: string[]): void {
  dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths })
}

const openFolder = (): Promise<OpenResponse> => handlers.get('json:open-folder')!() as Promise<OpenResponse>
const openFile = (index: number): Promise<OpenFileResponse> =>
  handlers.get('json:open-file')!(undefined, index) as Promise<OpenFileResponse>
const search = (query: string): Promise<SearchResponse> =>
  handlers.get('json:search')!(undefined, query) as Promise<SearchResponse>
const getAnnotations = (fileIndex: number | null): Promise<AnnotationsResponse> =>
  handlers.get('json:get-annotations')!(undefined, fileIndex) as Promise<AnnotationsResponse>
const addAnnotation = (request: unknown): Promise<AnnotationsResponse> =>
  handlers.get('json:add-annotation')!(undefined, request) as Promise<AnnotationsResponse>
const removeAnnotation = (request: unknown): Promise<AnnotationsResponse> =>
  handlers.get('json:remove-annotation')!(undefined, request) as Promise<AnnotationsResponse>
const getRecentFolders = (): Promise<RecentFolder[]> =>
  handlers.get('json:get-recent-folders')!(undefined) as Promise<RecentFolder[]>
const openRecentFolder = (path: string): Promise<OpenResponse> =>
  handlers.get('json:open-recent-folder')!(undefined, path) as Promise<OpenResponse>

async function readSidecar(folder: string, sourceName: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(folder, sourceName.replace(/\.json$/i, '') + '.annotations.json'), 'utf8'))
}

describe('window setup', () => {
  it('wires the fullscreen events the renderer listens for', () => {
    const win = browserWindowMock.mock.results[0]?.value as { on: ReturnType<typeof vi.fn> }
    const events = win.on.mock.calls.map((call) => call[0])
    expect(events).toContain('enter-full-screen')
    expect(events).toContain('leave-full-screen')
  })

  it('positions the traffic lights on the header tools row', () => {
    const call = browserWindowMock.mock.calls[0] as unknown[] | undefined
    const options = call?.[0] as { trafficLightPosition?: unknown } | undefined
    // The position is darwin-only chrome tuning; elsewhere it stays unset.
    if (process.platform === 'darwin') {
      expect(options?.trafficLightPosition).toEqual({ x: 16, y: 20 })
    } else {
      expect(options?.trafficLightPosition).toBeUndefined()
    }
  })

  it('declares json and markdown document associations', () => {
    const yml = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('fileAssociations:')
    expect(yml).toContain('ext: json')
    expect(yml).toContain('ext: md')
  })

  it('opens files macOS hands over and pushes the result to the renderer', async () => {
    const folder = await folderFixture('open-file-md', { 'readme.md': '# Handed over' })
    const registered = appMock.on.mock.calls.filter(([evt]) => evt === 'open-file' || evt === 'open-files')
    expect(registered.length).toBeGreaterThanOrEqual(2)
    const entry = registered.find(([evt]) => evt === 'open-file') as [string, (event: { preventDefault(): void }, path: string) => void]
    const event = { preventDefault: vi.fn() }
    entry[1](event, join(folder, 'readme.md'))
    expect(event.preventDefault).toHaveBeenCalled()
    const win = browserWindowMock.mock.results[0]?.value as { webContents: { send: ReturnType<typeof vi.fn> } }
    await vi.waitFor(() => {
      const opened = win.webContents.send.mock.calls.find(([channel]) => channel === 'file-opened')
      expect(opened?.[1]).toMatchObject({
        status: 'ok',
        fileName: 'readme.md',
        root: { type: 'markdown', text: '# Handed over' }
      })
    })
  })

  it('accumulates handoff opens into a temporary folder from the second file on', async () => {
    const win = browserWindowMock.mock.results[0]?.value as { webContents: { send: ReturnType<typeof vi.fn> } }
    const folderA = await folderFixture('handoff-a', { 'a.json': '[1]' })
    const folderB = await folderFixture('handoff-b', { 'b.md': '# B' })
    const registered = appMock.on.mock.calls.filter(([evt]) => evt === 'open-file')
    const entry = registered[registered.length - 1] as [string, (event: { preventDefault(): void }, path: string) => void]

    const handoff = async (path: string): Promise<OpenFileResponse> => {
      // Snapshot before dispatch: earlier pushes exist, so waiting for the
      // count to grow is the only way to grab THIS open's response.
      const before = win.webContents.send.mock.calls.filter(([channel]) => channel === 'file-opened').length
      entry[1]({ preventDefault: vi.fn() }, path)
      let pushed: OpenFileResponse | undefined
      await vi.waitFor(() => {
        const calls = win.webContents.send.mock.calls.filter(([channel]) => channel === 'file-opened')
        expect(calls.length).toBeGreaterThan(before)
        pushed = calls[calls.length - 1]?.[1] as OpenFileResponse
      })
      return pushed as OpenFileResponse
    }

    // A real folder open resets the accumulation, so this test is
    // order-independent no matter what earlier tests handed over.
    const resetter = await folderFixture('handoff-reset', { 'r.json': '[1]', 's.json': '[2]' })
    pick(resetter)
    await openFolder()

    // First handoff open: single-file mode, no folder.
    const first = await handoff(join(folderA, 'a.json'))
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.folder).toBeUndefined()

    // Second handoff open: the temporary folder appears and carries both
    // files, pointing at the file just opened.
    const second = await handoff(join(folderB, 'b.md'))
    if (second.status !== 'ok') return
    expect(second.folder).toEqual({ name: 'Opened files', files: ['a.json', 'b.md'], index: 1 })

    // Sidebar clicks resolve against the temporary folder's files.
    await expect(openFile(0)).resolves.toMatchObject({ status: 'ok', fileName: 'a.json' })
    await expect(openFile(1)).resolves.toMatchObject({ status: 'ok', fileName: 'b.md' })

    // Re-opening an accumulated file keeps its original position.
    const repeat = await handoff(join(folderA, 'a.json'))
    if (repeat.status !== 'ok') return
    expect(repeat.folder).toEqual({ name: 'Opened files', files: ['a.json', 'b.md'], index: 0 })

    // Opening a real folder ends the accumulation: the next handoff is
    // single-file again.
    const real = await folderFixture('handoff-real', { 'r.json': '[1]', 's.json': '[2]' })
    pick(real)
    await openFolder()
    const afterReal = await handoff(join(folderA, 'a.json'))
    if (afterReal.status !== 'ok') return
    expect(afterReal.folder).toBeUndefined()
  })

  it('keeps the last file-open result consumable for a renderer that mounts late', async () => {
    const folder = await folderFixture('open-file-race', { 'later.md': '# Race winner' })
    const registered = appMock.on.mock.calls.filter(([evt]) => evt === 'open-file')
    const entry = registered[registered.length - 1] as [string, (event: { preventDefault(): void }, path: string) => void]
    const event = { preventDefault: vi.fn() }
    entry[1](event, join(folder, 'later.md'))
    // The live send races the renderer's mount; the consume call is the
    // deterministic path a freshly mounted renderer takes instead. The
    // open itself is async, so wait for the result to land.
    const consume = handlers.get('json:consume-file-opened') as () => Promise<OpenFileResponse | null>
    let first: OpenFileResponse | null = null
    await vi.waitFor(async () => {
      first = (await consume()) as OpenFileResponse
      expect(first).toMatchObject({
        status: 'ok',
        fileName: 'later.md',
        root: { type: 'markdown', text: '# Race winner' }
      })
    })
    // Consumed once: it does not re-open on the next mount.
    const second = await consume()
    expect(second).toBeNull()
  })

  it('recreates the window when a file is handed over while the app has none', async () => {
    const folder = await folderFixture('open-file-windowless', { 'late.json': '[7]' })
    // The only window was closed (⌘W) while the app keeps running: macOS
    // hands the file over as a bare open-document event with no reopen, so
    // the delivery must bring a window back — nothing else will.
    const win = browserWindowMock.mock.results[0]?.value as { on: ReturnType<typeof vi.fn> }
    const closed = win.on.mock.calls.find(([evt]) => evt === 'closed')?.[1] as () => void
    closed()
    expect(browserWindowMock.mock.calls).toHaveLength(1)
    const registered = appMock.on.mock.calls.filter(([evt]) => evt === 'open-file')
    const entry = registered[registered.length - 1] as [string, (event: { preventDefault(): void }, path: string) => void]
    entry[1]({ preventDefault: vi.fn() }, join(folder, 'late.json'))
    // A second window is created for the delivery, and the result lands there.
    await vi.waitFor(() => expect(browserWindowMock.mock.calls).toHaveLength(2))
    const second = browserWindowMock.mock.results[1]?.value as { webContents: { send: ReturnType<typeof vi.fn> } }
    await vi.waitFor(() => {
      const opened = second.webContents.send.mock.calls.find(([channel]) => channel === 'file-opened')
      expect(opened?.[1]).toMatchObject({ status: 'ok', fileName: 'late.json', root: { type: 'array', count: 1 } })
    })
  })
})

describe('open folder', () => {
  it('only registers the folder-opening dialog flow', () => {
    expect(handlers.has('json:open-folder')).toBe(true)
    expect(handlers.has('json:open')).toBe(false)
  })

  it('opens a folder through a directory-only dialog', async () => {
    const folder = await folderFixture('multi', { 'b.json': '[2]', 'a.json': '[1]' })
    pick(folder)
    const result = await openFolder()
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openDirectory'] })
    )
    expect(result).toEqual({ status: 'folder', folderName: 'multi', files: ['a.json', 'b.json'] })
  })

  it('suggests choosing another folder when it contains no JSON files', async () => {
    const folder = await folderFixture('empty', { 'readme.txt': 'nothing here' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({
      status: 'error',
      fileName: 'empty',
      error: 'No JSON or Markdown files found in this folder. Please choose another folder.'
    })
  })

  it('lists markdown files alongside json ones', async () => {
    const folder = await folderFixture('mixed', { 'notes.md': '# Notes', 'data.json': '[1]' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'folder', folderName: 'mixed', files: ['data.json', 'notes.md'] })
  })

  it('opens a markdown file as a markdown root', async () => {
    const folder = await folderFixture('md-open', { 'readme.md': '# Hello\n\nworld body' })
    pick(folder)
    // A folder with a single .md file opens it directly, like a lone json.
    const result = await openFolder()
    expect(result).toEqual({
      status: 'ok',
      fileName: 'readme.md',
      root: { type: 'markdown', text: '# Hello\n\nworld body' }
    })
  })

  it('refuses markdown files past the preview size cap', async () => {
    const folder = await folderFixture('md-huge', { 'big.md': '# '.repeat(3 * 1024 * 1024) })
    pick(folder)
    // A lone .md opens directly from the folder call itself.
    const result = await openFolder()
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error).toBe('This markdown file is too large to preview.')
  })

  it('opens the only JSON file of a folder directly, without a folder panel', async () => {
    const folder = await folderFixture('lone', { 'only.json': '[1, 2]' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'ok', fileName: 'only.json', root: { type: 'array', count: 2 } })
    // No folder was recorded, so index-based opening is unavailable.
    expect(await openFile(0)).toEqual({ status: 'error', fileName: '', error: 'No folder is open.' })
  })

  it('skips hidden dotfiles when listing the files of a folder', async () => {
    const folder = await folderFixture('dotted', { '.hidden.json': '[]', 'a.json': '[]', 'b.json': '[]' })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({ status: 'folder', folderName: 'dotted', files: ['a.json', 'b.json'] })
  })

  it('loads a listed folder file by index', async () => {
    const folder = await folderFixture('indexed', { 'a.json': '{"x": 1}', 'b.json': '{"y": 2}' })
    pick(folder)
    await openFolder()
    expect(await openFile(1)).toEqual({
      status: 'ok',
      fileName: 'b.json',
      root: { type: 'value', value: { y: 2 } }
    })
  })

  it('reports a canceled dialog without changing anything', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await openFolder()).toEqual({ status: 'canceled' })
  })

  it('lists Open Folder as the only open command in the menu', () => {
    type Item = { label?: string; submenu?: Item[] }
    const template = menuMock.buildFromTemplate.mock.calls[0][0] as Item[]
    const file = template.find((item) => item.label === 'File')
    const labels = (file?.submenu ?? []).map((item) => item.label)
    expect(labels).toContain('Open Folder…')
    expect(labels).not.toContain('Open JSON…')
  })

  it('searches across all JSON files in the opened folder', async () => {
    const folder = await folderFixture('search-folder', {
      'a.json': '[{"word": "apple"}]',
      'b.json': '[{"word": "banana"}]',
      'c.json': '{"note": "apple pie"}'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
    const files = result.hits.map((hit) => hit.fileName)
    expect(files).toContain('a.json')
    expect(files).toContain('c.json')
    for (const hit of result.hits) {
      expect(hit.fileIndex).toBeGreaterThanOrEqual(0)
      expect(hit.fileName).toBeTruthy()
    }
  })

  it('includes array-item hits from another file with its file identity', async () => {
    const folder = await folderFixture('search-array', {
      'a.json': '[{"word": "one"}]',
      'b.json': '[{"word": "apple"}, {"word": "apple pie"}]'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const bHits = result.hits.filter((hit) => hit.fileName === 'b.json')
    expect(bHits.length).toBeGreaterThan(0)
    expect(bHits[0].fileIndex).toBe(1)
  })

  it('reports more folder matches when a single file exceeds the hit limit', async () => {
    const many = Array.from({ length: 15 }, () => '{"word": "apple"}').join(',')
    const folder = await folderFixture('search-more', {
      'many.json': `[${many}]`,
      'none.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    const result = await search('apple')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // 15 matches exist but the folder cap shows ten; the file-level flag
    // must surface so the "refine your search" hint appears.
    expect(result.hits.length).toBe(10)
    expect(result.moreAvailable).toBe(true)
  })

  it('cancels an in-flight folder search when another folder is opened', async () => {
    // The scan reads thousands of elements one await at a time, so it is
    // still running when the second, single-file folder opens and retires
    // it. The pending search must resolve as canceled — not reject with a
    // TypeError from the replaced (null) folder file list.
    const many = Array.from({ length: 2000 }, (_, i) => `{"word": "apple ${i}"}`).join(',')
    const folder = await folderFixture('search-race', { 'a.json': `[${many}]`, 'b.json': '[{"word": "apple"}]' })
    pick(folder)
    await openFolder()
    const pending = search('apple')
    const lone = await folderFixture('search-race-lone', { 'only.json': '[1]' })
    pick(lone)
    expect((await openFolder()).status).toBe('ok')
    await expect(pending).resolves.toEqual({ status: 'canceled' })
  })

  // Unlinking a file with an open handle only works on POSIX; on Windows the
  // delete itself fails, so these cache-reuse probes cannot run there.
  it.skipIf(process.platform === 'win32')('keeps analyzed array files warm across folder searches', async () => {
    const folder = await folderFixture('search-warm-array', {
      'a.json': '[{"word": "apple"}, {"word": "apple pie"}]',
      'b.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    expect((await search('apple')).status).toBe('ok')
    // Deleting the file proves the second query does not reopen it: the
    // cached entry keeps serving from its still-open handle.
    await rm(join(folder, 'a.json'))
    const second = await search('apple')
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.hits.map((hit) => hit.fileName)).toContain('a.json')
  })

  it.skipIf(process.platform === 'win32')('caches non-array file text across folder searches', async () => {
    const folder = await folderFixture('search-warm-text', {
      'c.json': '{"note": "apple pie"}',
      'd.json': '[{"word": "banana"}]'
    })
    pick(folder)
    await openFolder()
    const first = await search('apple')
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.hits.some((hit) => hit.fileName === 'c.json')).toBe(true)
    // Deleting the file proves the second query does not reread it: the
    // cached raw text keeps serving the hit.
    await rm(join(folder, 'c.json'))
    const second = await search('apple')
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.hits.some((hit) => hit.fileName === 'c.json')).toBe(true)
  })
})

describe('recent folders', () => {
  const storageFile = (): string => join(dir, 'userdata', 'recent-folders.json')
  const seedRecents = async (paths: string[]): Promise<void> => {
    await writeFile(
      storageFile(),
      JSON.stringify(paths.map((p) => ({ path: p, name: basename(p), lastOpenedAt: '2026-01-01T00:00:00.000Z' })))
    )
  }

  it('records opened folders most recent first', async () => {
    const a = await folderFixture('recents-a', { 'x.json': '[1]', 'y.json': '[2]' })
    const b = await folderFixture('recents-b', { 'x.json': '[1]', 'y.json': '[2]' })
    pick(a)
    await openFolder()
    pick(b)
    await openFolder()
    const folders = await getRecentFolders()
    expect(folders.slice(0, 2).map((f) => f.name)).toEqual(['recents-b', 'recents-a'])
  })

  it('reopens a folder by path without the dialog', async () => {
    const folders = await getRecentFolders()
    const result = await openRecentFolder(folders[0].path)
    expect(result).toEqual({ status: 'folder', folderName: 'recents-b', files: ['x.json', 'y.json'] })
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled()
  })

  it('keeps at most three entries, most recent first', async () => {
    await seedRecents(['/r/one', '/r/two', '/r/three'])
    const four = await folderFixture('recents-four', { 'x.json': '[1]', 'y.json': '[2]' })
    pick(four)
    await openFolder()
    const folders = await getRecentFolders()
    expect(folders).toHaveLength(3)
    expect(folders.map((f) => f.name)).toEqual(['recents-four', 'one', 'two'])
  })

  it('drops a vanished folder from the recents when reopened', async () => {
    const ghost = join(dir, 'recents-ghost')
    await seedRecents([ghost, '/r/two'])
    const result = await openRecentFolder(ghost)
    expect(result).toMatchObject({ status: 'error' })
    const folders: RecentFolder[] = await getRecentFolders()
    expect(folders.map((f) => f.path)).not.toContain(ghost)
  })
})

describe('annotations', () => {
  // Lines are numbered so annotation locations are predictable:
  // the "error" value of item 2 sits on line 6.
  const logJson = `[
  {"id": 1},
  {
    "id": 2,
    "status": "failed",
    "error": "connection refused"
  }
]`

  it('lists sidecar annotation files right after the file they belong to', async () => {
    const folder = await folderFixture('annotated-listing', {
      'logs.annotations.json': '{"version":1,"sourceFile":"logs.json","annotations":[]}',
      'logs.json': '[1]',
      'notes.annotations.json': '{"version":1,"sourceFile":"notes.json","annotations":[]}',
      'notes.json': '[2]'
    })
    pick(folder)
    const result = await openFolder()
    expect(result).toEqual({
      status: 'folder',
      folderName: 'annotated-listing',
      files: ['logs.json', 'logs.annotations.json', 'notes.json', 'notes.annotations.json']
    })
  })

  it('starts with no annotations for a fresh file', async () => {
    const folder = await folderFixture('annotations-fresh', { 'a.json': '[1]', 'b.json': '[2]' })
    pick(folder)
    await openFolder()
    const result = await getAnnotations(0)
    expect(result).toEqual({ status: 'ok', annotations: [] })
  })

  it('records a value annotation with its line, byte offset and snippet', async () => {
    const folder = await folderFixture('annotations-value', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'The service never answered.' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.annotations).toHaveLength(1)
    const [annotation] = result.annotations
    expect(annotation).toMatchObject({
      itemIndex: 1,
      path: ['error'],
      line: 6,
      snippet: '"connection refused"',
      message: 'The service never answered.'
    })
    expect(annotation.byteOffset).toBeGreaterThan(0)
    expect(annotation.id).toBeTruthy()
    expect(annotation.createdAt).toBeTruthy()

    // The sidecar sits next to the source file and holds the same data.
    const sidecar = await readSidecar(folder, 'logs.json')
    expect(sidecar).toMatchObject({ version: 1, sourceFile: 'logs.json' })
    expect((sidecar.annotations as unknown[]).length).toBe(1)
    // Loading the annotations again returns what was stored.
    const reread = await getAnnotations(0)
    expect(reread.status).toBe('ok')
    if (reread.status !== 'ok') return
    expect(reread.annotations).toEqual(result.annotations)
  })

  it('adds the sidecar of a first annotation to the open folder listing', async () => {
    const folder = await folderFixture('annotations-appear', { 'a.json': '[{"msg": "boom"}]', 'b.json': '[2]' })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['msg'], message: 'flagged' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // The new sidecar is reported so the panel can show it without a reopen,
    // right after its source file — every later file keeps its neighbors.
    expect(result.files).toEqual(['a.json', 'a.annotations.json', 'b.json'])
    // The sidecar is a readable JSON file of the folder, at its new index.
    expect(await openFile(1)).toMatchObject({ status: 'ok', fileName: 'a.annotations.json' })
    expect(await openFile(2)).toMatchObject({ status: 'ok', fileName: 'b.json' })
    // A further annotation of the same file adds nothing to the listing.
    const again = await addAnnotation({ fileIndex: 0, itemIndex: 0, path: null, message: 'whole item' })
    expect(again.status).toBe('ok')
    if (again.status !== 'ok') return
    expect(again.files).toBeUndefined()
    expect(await openFile(2)).toMatchObject({ status: 'ok', fileName: 'b.json' })
  })

  it('locates the annotated value exactly when items start on one line', async () => {
    const folder = await folderFixture('annotations-inline', {
      'inline.json': '[{"id": 1, "msg": "boom"}, {"id": 2, "msg": "fine"}]',
      'other.json': '[1]'
    })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['msg'], message: '' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // No note was sent, so the value's own text becomes the message.
    expect(result.annotations[0]).toMatchObject({ line: 1, snippet: '"boom"', message: '"boom"' })
  })

  it('annotates a whole item without a path', async () => {
    const folder = await folderFixture('annotations-item', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const result = await addAnnotation({
      fileIndex: 0,
      itemIndex: 1,
      path: null,
      message: 'Item 2 is not valid JSON: unexpected token.'
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // The item's own start line is the finest location available, and the
    // whole element text becomes its excerpt.
    expect(result.annotations[0]).toMatchObject({ itemIndex: 1, path: null, line: 3 })
  })

  it('annotates an item that failed to parse in the viewer', async () => {
    const folder = await folderFixture('annotations-broken-item', {
      'broken.json': '[{"ok": 1}, {"broken": }]',
      'other.json': '[1]'
    })
    pick(folder)
    await openFolder()
    const opened = await openFile(0)
    expect(opened.status).toBe('ok')
    const item = await handlers.get('json:get-item')!(undefined, 1)
    expect(item).toMatchObject({ status: 'error' })
    const result = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: null, message: 'Bad element in the dump.' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.annotations[0]).toMatchObject({ itemIndex: 1, path: null, line: 1 })
  })

  it('records selection ranges precisely and trims overlaps on one value', async () => {
    const folder = await folderFixture('annotations-ranges', { 'a.json': '[{"msg": "hello brave world"}]', 'b.json': '[1]' })
    pick(folder)
    await openFolder()
    // Two non-overlapping word selections on the same value.
    const first = await addAnnotation({
      fileIndex: 0, itemIndex: 0, path: ['msg'], message: 'brave', range: { start: 6, end: 11 }
    })
    expect(first.status, JSON.stringify(first)).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.annotations).toHaveLength(1)
    const second = await addAnnotation({
      fileIndex: 0, itemIndex: 0, path: ['msg'], message: 'world', range: { start: 12, end: 17 }
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.annotations).toHaveLength(2)
    // An overlapping selection replaces the covered parts: [4, 9) cuts
    // [6, 11) down to [9, 11).
    const third = await addAnnotation({
      fileIndex: 0, itemIndex: 0, path: ['msg'], message: 'hello', range: { start: 4, end: 9 }
    })
    expect(third.status).toBe('ok')
    if (third.status !== 'ok') return
    const brave = third.annotations.find((a) => a.message === 'brave')
    expect(brave?.range).toEqual({ start: 9, end: 11 })
    // Removing one range leaves the other untouched; removing an exact
    // missing range is a no-op.
    const removed = await removeAnnotation({
      fileIndex: 0, itemIndex: 0, path: ['msg'], range: { start: 4, end: 9 }
    })
    expect(removed.status).toBe('ok')
    if (removed.status !== 'ok') return
    expect(removed.annotations.map((a) => a.range)).toEqual([{ start: 9, end: 11 }, { start: 12, end: 17 }])
    const again = await removeAnnotation({
      fileIndex: 0, itemIndex: 0, path: ['msg'], range: { start: 4, end: 9 }
    })
    expect(again.status).toBe('ok')
    if (again.status !== 'ok') return
    expect(again.annotations.map((a) => a.range)).toEqual([{ start: 9, end: 11 }, { start: 12, end: 17 }])
  })

  it('annotates a file that failed to open, marking the error annotatable', async () => {
    const folder = await folderFixture('annotations-broken-file', { 'broken.json': '{not json' })
    pick(folder)
    const result = await openFolder()
    // A single broken file is opened directly and fails.
    expect(result).toMatchObject({ status: 'error', fileName: 'broken.json', annotatable: true })
    const saved = await addAnnotation({ fileIndex: null, itemIndex: null, path: null, message: 'Invalid JSON at line 1.' })
    expect(saved).toEqual({
      status: 'ok',
      annotations: [expect.objectContaining({ itemIndex: null, path: null, line: null, message: 'Invalid JSON at line 1.' })]
    })
  })

  it('reports errors for impossible annotation targets', async () => {
    const folder = await folderFixture('annotations-errors', { 'a.json': '[1]', 'b.json': '{"k": "v"}' })
    pick(folder)
    await openFolder()
    await openFile(0)

    // Out-of-range item.
    expect(await addAnnotation({ fileIndex: 0, itemIndex: 9, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'The annotated item does not exist in this file.'
    })
    // Path that does not exist in the item.
    expect(await addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['nope'], message: 'x' })).toEqual({
      status: 'error',
      message: 'The annotated location does not exist in this file.'
    })
    // A path inside a value-root file is fine; a bogus index on it is not.
    expect(await addAnnotation({ fileIndex: 1, itemIndex: 0, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'The file is not a JSON array.'
    })
    // Malformed requests.
    expect((await addAnnotation(null)).status).toBe('error')
    expect((await addAnnotation({ fileIndex: 0, itemIndex: 0, path: [{}], message: 'x' })).status).toBe('error')
    expect((await addAnnotation({ fileIndex: 0, itemIndex: 0, path: null })).status).toBe('error')
    // Nothing is written when a request fails.
    expect(await getAnnotations(0)).toEqual({ status: 'ok', annotations: [] })
  })

  it('rejects annotations when no file backs the request', async () => {
    // The suite's earlier tests leave files open, so only a folder index
    // outside the opened folder proves the "nothing to annotate" path.
    const folder = await folderFixture('annotations-no-file', { 'a.json': '[1]', 'b.json': '[2]' })
    pick(folder)
    await openFolder()
    expect(await addAnnotation({ fileIndex: 5, itemIndex: 0, path: null, message: 'x' })).toEqual({
      status: 'error',
      message: 'No file is open.'
    })
    expect(await getAnnotations(5)).toEqual({ status: 'error', message: 'No file is open.' })
    expect(await removeAnnotation({ fileIndex: 9, itemIndex: 0, path: null })).toEqual({
      status: 'error',
      message: 'No file is open.'
    })
    // A negative index is not a location probe at all — the request itself
    // is malformed.
    expect(await removeAnnotation({ fileIndex: -1, itemIndex: 0, path: null })).toEqual({
      status: 'error',
      message: 'The annotation request is invalid.'
    })
  })

  it('replaces an existing annotation of the same location instead of duplicating it', async () => {
    const folder = await folderFixture('annotations-dedupe', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'first' })
    const second = await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'second' })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.annotations).toHaveLength(1)
    expect(second.annotations[0].message).toBe('second')
  })

  it('removes an annotation by location, tolerating unknown ones', async () => {
    const folder = await folderFixture('annotations-remove', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    await addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'flagged' })
    const removed = await removeAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'] })
    expect(removed).toEqual({ status: 'ok', annotations: [] })
    // Removing a location that has none changes nothing.
    expect(await removeAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'] })).toEqual({
      status: 'ok',
      annotations: []
    })
    const sidecar = await readSidecar(folder, 'logs.json')
    expect(sidecar.annotations).toEqual([])
  })

  it('keeps annotations of the same file written concurrently', async () => {
    const folder = await folderFixture('annotations-race', { 'logs.json': logJson, 'other.json': '[1]' })
    pick(folder)
    await openFolder()
    const results = await Promise.all([
      addAnnotation({ fileIndex: 0, itemIndex: 0, path: ['id'], message: 'one' }),
      addAnnotation({ fileIndex: 0, itemIndex: 1, path: ['error'], message: 'two' })
    ])
    for (const result of results) expect(result.status).toBe('ok')
    const stored = await getAnnotations(0)
    expect(stored.status).toBe('ok')
    if (stored.status !== 'ok') return
    expect(stored.annotations.map((annotation) => annotation.message).sort()).toEqual(['one', 'two'])
  })

  it('annotates the single open file when no folder is open', async () => {
    const folder = await folderFixture('annotations-single', {
      'only.json': '{\n  "note": "odd value"\n}'
    })
    pick(folder)
    const result = await openFolder()
    expect(result).toMatchObject({ status: 'ok', fileName: 'only.json' })
    const saved = await addAnnotation({ fileIndex: null, itemIndex: null, path: ['note'], message: 'check this' })
    expect(saved.status).toBe('ok')
    if (saved.status !== 'ok') return
    expect(saved.annotations[0]).toMatchObject({ itemIndex: null, path: ['note'], line: 2, snippet: '"odd value"' })
    expect(await getAnnotations(null)).toEqual(saved)
  })
})
