import { useEffect, useState } from 'react'

export type DesktopInstanceStatus =
  'connecting' | 'ready' | 'unstable' | 'offline' | 'authentication-required' | 'incompatible'

export interface DesktopInstancePresentation {
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

export const useDesktopInstance = (): {
  readonly enabled: boolean
  readonly presentation: DesktopInstancePresentation
} => {
  const bridge = typeof window === 'undefined' ? undefined : window.nekroDesktopShell
  const [presentation, setPresentation] = useState(fallback)
  useEffect(() => {
    if (bridge === undefined) return
    let current = true
    void bridge.getCurrentInstancePresentation().then((state) => {
      if (current) setPresentation(state)
    })
    const unsubscribe = bridge.subscribeCurrentInstanceStatus(setPresentation)
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
