import { flushSync } from 'react-dom'

let activeViewTransition: ViewTransition | null = null

export const runNxtNavigation = (go: () => void, morph: boolean): void => {
  if (!morph || typeof document.startViewTransition !== 'function') {
    go()
    return
  }
  try {
    activeViewTransition?.skipTransition()
    const transition = document.startViewTransition(() => {
      flushSync(go)
    })
    activeViewTransition = transition
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (activeViewTransition === transition) activeViewTransition = null
      })
  } catch {
    go()
  }
}
