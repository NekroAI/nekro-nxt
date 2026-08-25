type StableCursorIntent = 'pointer' | 'text' | 'grab' | 'grabbing' | 'col-resize'

const textControlSelector =
  "textarea, input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']), [contenteditable]:not([contenteditable='false'])"

const pointerControlSelector =
  "button, a[href], select, [role='button'], [role='tab'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='switch'], input[type='checkbox'], input[type='radio'], label[for], summary"

const cursorIntentFor = (target: EventTarget | null, buttons: number): StableCursorIntent | undefined => {
  if (!(target instanceof Element)) return undefined
  if (target.closest(textControlSelector)) return 'text'
  if (target.closest('[data-work-tree-drag], input[type="range"]')) return buttons === 0 ? 'grab' : 'grabbing'
  if (target.closest('[role="separator"]')) return 'col-resize'
  if (target.closest(pointerControlSelector)) return 'pointer'
  return undefined
}

/**
 * Keeps one cursor intent for the whole current hit target. This prevents a
 * native WebContentsView from briefly falling back to the arrow while an
 * interactive control replaces descendants or changes state under the mouse.
 */
export const installStableCursorIntent = (targetDocument: Document = document): (() => void) => {
  const root = targetDocument.documentElement
  const update = (event: PointerEvent): void => {
    const intent = cursorIntentFor(event.target, event.buttons)
    if (intent === undefined) delete root.dataset['nxtCursor']
    else root.dataset['nxtCursor'] = intent
  }
  const clear = (): void => {
    delete root.dataset['nxtCursor']
  }

  targetDocument.addEventListener('pointerover', update, true)
  targetDocument.addEventListener('pointermove', update, true)
  targetDocument.addEventListener('pointerleave', clear, true)
  targetDocument.defaultView?.addEventListener('blur', clear)

  return () => {
    targetDocument.removeEventListener('pointerover', update, true)
    targetDocument.removeEventListener('pointermove', update, true)
    targetDocument.removeEventListener('pointerleave', clear, true)
    targetDocument.defaultView?.removeEventListener('blur', clear)
    clear()
  }
}
