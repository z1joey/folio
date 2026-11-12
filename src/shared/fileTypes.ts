/**
 * The file types Folio can open, shared between the main process (folder
 * listing, dropped/handoff file filtering) and the renderer (drop filter).
 */

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] as const

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

/** True for a file name Folio can open: .json, .md, or an image. */
export function isOpenableFileName(name: string): boolean {
  if (/\.json$/i.test(name) || /\.md$/i.test(name)) return true
  return isImageFile(name)
}

/** True for image file names (extension-based, case-insensitive). */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(`.${ext}`))
}

/** The image mime type for a file extension (without the dot). */
export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}
