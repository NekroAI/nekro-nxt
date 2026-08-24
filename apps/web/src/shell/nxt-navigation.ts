import { flushSync } from 'react-dom'

let activeViewTransition: ViewTransition | null = null
const transitionAttribute = 'data-nxt-view-transition'

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
    document.documentElement.setAttribute(transitionAttribute, '')
    void transition.ready.catch(() => undefined)
    void transition.updateCallbackDone.catch(() => undefined)
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (activeViewTransition !== transition) return
        activeViewTransition = null
        document.documentElement.removeAttribute(transitionAttribute)
      })
  } catch {
    go()
  }
}
