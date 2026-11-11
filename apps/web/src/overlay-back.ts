import { inAndroidShell, postToAndroidShell } from './android-shell.js'

/**
 * Lets the system back gesture close an open overlay before it leaves the page, as native apps do.
 *
 * Every overlay in the kit is a Radix layer that closes on Escape, the topmost first, so "close the top overlay" is an
 * Escape keypress. No history entries are pushed for overlays: they would have to be popped again whenever an overlay
 * closes some other way, and would collide with the bottom bar's tab history.
 *
 * - The Android shell asks through `window.nekroShellBack()` and learns whether one is open from `overlay` messages.
 * - Chrome on a phone (browser or installed PWA) routes the back gesture to a `CloseWatcher` while one is open.
 */

const OPEN_OVERLAY =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'

declare global {
  interface Window {
    nekroShellBack?: () => boolean
  }
}

interface CloseWatcherLike {
  onclose: (() => void) | null
  destroy(): void
}

type CloseWatcherConstructor = new () => CloseWatcherLike

export const overlayOpen = (doc: Document = document): boolean => doc.querySelector(OPEN_OVERLAY) !== null

/** Closes the topmost overlay; false when none is open, so back can go on to the page. */
export const closeTopOverlay = (doc: Document = document): boolean => {
  if (!overlayOpen(doc)) return false
  const target = doc.activeElement instanceof HTMLElement ? doc.activeElement : doc.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  return true
}

export function installOverlayBack(doc: Document = document): () => void {
  const win = doc.defaultView
  if (win === null) return () => undefined
  const android = inAndroidShell()
  // Only phones: on a computer Escape also triggers a CloseWatcher and would close a second layer.
  const Watcher = (win as Window & { readonly CloseWatcher?: CloseWatcherConstructor }).CloseWatcher
  const watchBack = !android && Watcher !== undefined && win.matchMedia?.('(pointer: coarse)').matches === true
  let open = false
  let watcher: CloseWatcherLike | undefined
  let scheduled = false

  const sync = () => {
    scheduled = false
    const next = overlayOpen(doc)
    if (next === open) return
    open = next
    if (android) postToAndroidShell({ type: 'overlay', open })
    if (!watchBack || Watcher === undefined) return
    if (open) {
      watcher = new Watcher()
      watcher.onclose = () => {
        watcher = undefined
        open = false
        closeTopOverlay(doc)
        schedule()
      }
    } else {
      watcher?.destroy()
      watcher = undefined
    }
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(sync)
  }

  win.nekroShellBack = () => closeTopOverlay(doc)
  const observer = new MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
  sync()
  return () => {
    observer.disconnect()
    watcher?.destroy()
    delete win.nekroShellBack
  }
}
