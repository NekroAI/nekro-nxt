/**
 * Whether a page shows anything: a media or form element, or text that is laid out. The check must not depend on the
 * host being on screen: background runs render inside a `visibility: hidden` host, where `innerText` is empty for
 * every page (#99). Text under `display: none` does not count.
 */
export function hasVisibleContent(content: HTMLElement): boolean {
  if (content.querySelector('img, svg, canvas, input, select, textarea, video')) return true
  const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    const parent = node.parentElement
    if (parent === null || typeof parent.checkVisibility !== 'function' || parent.checkVisibility()) return true
  }
  return false
}
