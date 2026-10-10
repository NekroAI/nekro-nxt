import type { ExtensionClientHost, ExtensionUploadResult } from '@nekro-nxt/extension-sdk'
import { managementCsrfToken } from '../management-access.js'

const libraryPath = (extensionId: string) => `/api/extension-library/${encodeURIComponent(extensionId)}/assets`

const isUploadResult = (value: unknown): value is ExtensionUploadResult =>
  typeof value === 'object' &&
  value !== null &&
  'added' in value &&
  Array.isArray(value.added) &&
  'skipped' in value &&
  Array.isArray(value.skipped)

const sendFile = (
  extensionId: string,
  file: Blob & { readonly name: string },
  onProgress: (sentBytes: number) => void,
): Promise<ExtensionUploadResult> =>
  new Promise((resolve, reject) => {
    // XHR rather than fetch: it reports upload progress, which matters for large archives.
    const request = new XMLHttpRequest()
    request.open('POST', libraryPath(extensionId))
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.setRequestHeader('x-nekro-file-name', encodeURIComponent(file.name))
    const csrf = managementCsrfToken()
    if (csrf !== undefined) request.setRequestHeader('x-nxt-csrf', csrf)
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onload = () => {
      try {
        const body: unknown = JSON.parse(request.responseText)
        if (request.status >= 200 && request.status < 300 && isUploadResult(body)) {
          resolve(body)
          return
        }
        const message =
          typeof body === 'object' && body !== null && 'message' in body ? String(body.message) : request.statusText
        reject(new Error(message || '上传失败'))
      } catch {
        reject(new Error('上传失败'))
      }
    }
    request.onerror = () => reject(new Error('上传失败，请检查网络连接'))
    request.send(file)
  })

/** Library methods of an installed extension's Client host. */
export const createLibraryHost = (extensionId: string): Pick<ExtensionClientHost, 'upload' | 'assetUrl'> => ({
  async upload(files, options) {
    const blobs = files.filter((file): file is Blob & { readonly name: string } => file instanceof Blob)
    const totalBytes = blobs.reduce((sum, file) => sum + file.size, 0)
    let finishedBytes = 0
    const added: ExtensionUploadResult['added'][number][] = []
    const skipped: ExtensionUploadResult['skipped'][number][] = []
    for (const file of blobs) {
      try {
        const result = await sendFile(extensionId, file, (sent) =>
          options?.onProgress?.({ sentBytes: finishedBytes + sent, totalBytes }),
        )
        added.push(...result.added)
        skipped.push(...result.skipped)
      } catch (error) {
        skipped.push({ name: file.name, reason: error instanceof Error ? error.message : String(error) })
      }
      finishedBytes += file.size
      options?.onProgress?.({ sentBytes: finishedBytes, totalBytes })
    }
    return { added, skipped }
  },
  assetUrl: (assetId, options) =>
    `${libraryPath(extensionId)}/${encodeURIComponent(assetId)}${options?.thumbnail === true ? '?thumbnail=1' : ''}`,
})

/** Pages of DSH plugins have no extension library. */
export const unavailableLibraryHost: Pick<ExtensionClientHost, 'upload' | 'assetUrl'> = {
  upload: () => Promise.reject(new Error('这个页面不属于扩展，没有扩展资源库。')),
  assetUrl: () => '',
}
