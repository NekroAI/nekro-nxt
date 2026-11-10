/**
 * Keeps the app inside the part of the screen the on-screen keyboard leaves visible.
 *
 * Android Chrome resizes the page itself (`interactive-widget=resizes-content` in index.html), so the shell's dynamic
 * viewport height already ends at the keyboard. iOS Safari never resizes the page for the keyboard: it only shrinks
 * and pans the visual viewport. There the shell follows the visual viewport through `--viewport-top` and
 * `--viewport-height`, and fixed panels (sheets, dialogs) stop at `--keyboard-inset`.
 *
 * Either way `data-keyboard` marks the root while the keyboard is up, so a phone can put away its bottom bar.
 */

/** A keyboard takes far more than the browser's own toolbars, which also change the viewport height. */
const KEYBOARD_MIN_HEIGHT = 120

export interface ViewportSource {
  readonly height: number
  readonly offsetTop: number
  readonly scale: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

const editing = (element: Element | null): boolean =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      !['checkbox', 'radio', 'range', 'file', 'color', 'button', 'submit', 'reset'].includes(element.type)))

export function installKeyboardViewport(
  root: HTMLElement = document.documentElement,
  viewport: ViewportSource | null = window.visualViewport,
): () => void {
  // The tallest the page has been at the current width; turning the phone starts over.
  const touch = window.matchMedia?.('(pointer: coarse)')
  let width = window.innerWidth
  let fullHeight = window.innerHeight
  const update = () => {
    // iOS scrolls the whole document to reveal a focused field and leaves it there after the keyboard goes, pushing
    // the top bar off screen and leaving a blank strip below the bottom bar. The app never scrolls its document.
    if (touch?.matches && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0)
    if (window.innerWidth !== width) {
      width = window.innerWidth
      fullHeight = window.innerHeight
    }
    fullHeight = Math.max(fullHeight, window.innerHeight)
    const layoutHeight = root.clientHeight
    // A pinch zoom also shrinks the visual viewport; only a keyboard counts.
    const visual = viewport && viewport.scale < 1.01 ? viewport : undefined
    const covered = visual ? layoutHeight - visual.height : 0
    const resized = fullHeight - window.innerHeight
    const open =
      touch?.matches === true && editing(document.activeElement) && Math.max(covered, resized) >= KEYBOARD_MIN_HEIGHT
    if (open) root.dataset['keyboard'] = 'open'
    else delete root.dataset['keyboard']
    if (open && visual && covered >= KEYBOARD_MIN_HEIGHT) {
      root.style.setProperty('--viewport-top', `${Math.round(visual.offsetTop)}px`)
      root.style.setProperty('--viewport-height', `${Math.round(visual.height)}px`)
      root.style.setProperty(
        '--keyboard-inset',
        `${Math.max(0, Math.round(layoutHeight - visual.offsetTop - visual.height))}px`,
      )
    } else {
      root.style.removeProperty('--viewport-top')
      root.style.removeProperty('--viewport-height')
      root.style.removeProperty('--keyboard-inset')
    }
  }
  // Focus moves before the keyboard animates in or out; the viewport events then report its final size.
  const settle = () => requestAnimationFrame(update)
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('scroll', update)
  document.addEventListener('focusin', settle)
  document.addEventListener('focusout', settle)
  update()
  return () => {
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    window.removeEventListener('scroll', update)
    document.removeEventListener('focusin', settle)
    document.removeEventListener('focusout', settle)
    delete root.dataset['keyboard']
    root.style.removeProperty('--viewport-top')
    root.style.removeProperty('--viewport-height')
    root.style.removeProperty('--keyboard-inset')
  }
}
