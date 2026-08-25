import { useEffect, useState } from 'react'

export type DesktopInstanceStatus =
  'connecting' | 'ready' | 'unstable' | 'offline' | 'authentication-required' | 'incompatible'

export interface DesktopInstancePresentation {
  /** Added by newer Desktop builds; protocol 1 bridges may omit it. */
  readonly revision?: number
  readonly displayName: string
  readonly status: DesktopInstanceStatus
}

export interface DesktopShellBridge {
  getCurrentInstancePresentation(): Promise<DesktopInstancePresentation>
  openInstanceSwitcher(): Promise<void>
  closeInstanceSwitcher(): Promise<void>
  subscribeCurrentInstanceStatus(listener: (state: DesktopInstancePresentation) => void): () => void
}

declare global {
  interface Window {
    readonly nekroDesktopShell?: DesktopShellBridge
  }
}

const fallback: DesktopInstancePresentation = { displayName: '本地实例', status: 'connecting' }

type PresentationSource = 'initial' | 'subscription'

/** Orders protocol-1 legacy events by arrival while preserving monotonic revisions when present. */
export class DesktopPresentationOrdering {
  #acceptedSubscription = false
  #latestRevision: number | undefined

  accept(candidate: DesktopInstancePresentation, source: PresentationSource): boolean {
    const revision = Number.isSafeInteger(candidate.revision) ? candidate.revision : undefined
    if (source === 'initial' && this.#acceptedSubscription) return false
    if (revision !== undefined) {
      if (this.#latestRevision !== undefined && revision <= this.#latestRevision) return false
      this.#latestRevision = revision
    } else if (source === 'subscription' && this.#latestRevision !== undefined) {
      return false
    }
    if (source === 'subscription') this.#acceptedSubscription = true
    return true
  }
}

export const useDesktopInstance = (): {
  readonly enabled: boolean
  readonly presentation: DesktopInstancePresentation
} => {
  const bridge = typeof window === 'undefined' ? undefined : window.nekroDesktopShell
  const [presentation, setPresentation] = useState(fallback)
  useEffect(() => {
    if (bridge === undefined) return
    let current = true
    const ordering = new DesktopPresentationOrdering()
    const accept = (state: DesktopInstancePresentation, source: PresentationSource): void => {
      if (current && ordering.accept(state, source)) setPresentation(state)
    }
    void bridge
      .getCurrentInstancePresentation()
      .then((state) => accept(state, 'initial'))
      .catch(() => undefined)
    const unsubscribe = bridge.subscribeCurrentInstanceStatus((state) => accept(state, 'subscription'))
    return () => {
      current = false
      unsubscribe()
    }
  }, [bridge])
  return {
    enabled: bridge !== undefined,
    presentation,
  }
}
