/** The class that fades the splash out; index.html defines its 180ms transition. */
const LEAVING_CLASS = 'boot-splash-leaving'
const FADE_MS = 180

/** The part of the splash element and its document this module touches; the real DOM satisfies it. */
export interface SplashNode {
  readonly classList: { contains(name: string): boolean; add(name: string): void }
  addEventListener(type: 'transitionend', listener: () => void): void
  remove(): void
}
export interface SplashDocument {
  getElementById(id: string): SplashNode | null
}

/**
 * Removes index.html's splash once the app has painted its first screen: it fades out, then leaves the DOM. Does
 * nothing when the splash is already gone or already leaving.
 */
export const removeBootSplash = (doc: SplashDocument = document): void => {
  const splash = doc.getElementById('boot-splash')
  if (!splash || splash.classList.contains(LEAVING_CLASS)) return
  splash.classList.add(LEAVING_CLASS)
  // A fade that never runs (hidden tab, reduced motion) must not leave the splash covering the app.
  const timer = setTimeout(() => splash.remove(), FADE_MS + 70)
  splash.addEventListener('transitionend', () => {
    clearTimeout(timer)
    splash.remove()
  })
}
