import { inAndroidShell, postToAndroidShell } from './android-shell.js'

const dataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败。'))
    reader.readAsDataURL(blob)
  })

/**
 * Saves a file made in the page. Browsers download it through a temporary link; the Android WebView cannot fetch
 * such links natively, so the shell receives the bytes and writes them to Downloads itself.
 */
export const saveBlob = async (blob: Blob, filename: string): Promise<void> => {
  if (inAndroidShell()) {
    const data = await dataUrl(blob)
    postToAndroidShell({ type: 'save-file', name: filename, mime: blob.type, data: data.slice(data.indexOf(',') + 1) })
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
