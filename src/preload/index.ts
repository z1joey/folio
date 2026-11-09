import { contextBridge, ipcRenderer } from 'electron'
import type { JsonReaderApi } from '../shared/types'

const api: JsonReaderApi = {
  openFolder: () => ipcRenderer.invoke('json:open-folder'),
  getRecentFolders: () => ipcRenderer.invoke('json:get-recent-folders'),
  openRecentFolder: (path: string) => ipcRenderer.invoke('json:open-recent-folder', path),
  openFile: (index: number) => ipcRenderer.invoke('json:open-file', index),
  getItem: (index: number) => ipcRenderer.invoke('json:get-item', index),
  search: (query: string) => ipcRenderer.invoke('json:search', query),
  getAnnotations: (fileIndex: number | null) => ipcRenderer.invoke('json:get-annotations', fileIndex),
  addAnnotation: (request) => ipcRenderer.invoke('json:add-annotation', request),
  removeAnnotation: (request) => ipcRenderer.invoke('json:remove-annotation', request),
  onOpenFolderRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('open-folder-requested', listener)
    return () => ipcRenderer.removeListener('open-folder-requested', listener)
  },
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    const listener = (_: unknown, isFullscreen: boolean): void => callback(isFullscreen)
    ipcRenderer.on('fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('fullscreen-changed', listener)
  },
  getVersion: () => ipcRenderer.invoke('json:get-version')
}

contextBridge.exposeInMainWorld('jsonReader', api)
