/**
 * Copies text, falling back to a hidden selection when the Clipboard API is missing (plain HTTP on a LAN address)
 * or refused. Resolves to whether the text reached the clipboard.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection copy below.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  document.body.append(area)
  area.select()
  try {
    // `execCommand` is deprecated but remains the only copy path outside a secure context.
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    active?.focus()
  }
}
