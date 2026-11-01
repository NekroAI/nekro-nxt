import { useCallback, useEffect, useState } from 'react'

/**
 * Settings → 关于 → 更新 talks to the Desktop main process through `window.nekroDesktopUpdate`. The bridge exists only
 * in the Desktop app and answers only the local instance's own page; elsewhere the row keeps the release link.
 */
export type DesktopUpdateState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'downloading'
      readonly version: string
      readonly received: number
      readonly total: number
      readonly source: string
    }
  | { readonly phase: 'ready'; readonly version: string }
  | { readonly phase: 'installing'; readonly version: string }
  | { readonly phase: 'failed'; readonly version?: string; readonly error: string }

export type DesktopPlatform = 'mac' | 'win' | 'linux'

export interface DesktopUpdateBridge {
  state(): Promise<
    | { readonly supported: false }
    | { readonly supported: true; readonly platform: DesktopPlatform; readonly state: DesktopUpdateState }
  >
  download(): Promise<DesktopUpdateState>
  cancel(): Promise<DesktopUpdateState>
  install(): Promise<DesktopUpdateState>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
}

declare global {
  interface Window {
    readonly nekroDesktopUpdate?: DesktopUpdateBridge
  }
}

const bridge = (): DesktopUpdateBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.nekroDesktopUpdate

/** The desktop app's own update download, or `undefined` in a browser or on a remote instance. */
export function useDesktopUpdate():
  | {
      readonly platform: DesktopPlatform
      readonly state: DesktopUpdateState
      readonly download: () => Promise<void>
      readonly cancel: () => Promise<void>
      readonly install: () => Promise<void>
    }
  | undefined {
  const [desktop] = useState(bridge)
  const [support, setSupport] = useState<{ platform: DesktopPlatform; state: DesktopUpdateState } | undefined>()
  useEffect(() => {
    if (desktop === undefined) return
    let live = true
    void desktop
      .state()
      .then((answer) => {
        if (live && answer.supported) setSupport({ platform: answer.platform, state: answer.state })
      })
      .catch(() => undefined)
    const detach = desktop.subscribe((state) => setSupport((current) => current && { ...current, state }))
    return () => {
      live = false
      detach()
    }
  }, [desktop])
  const apply = useCallback(
    async (action: (bridge: DesktopUpdateBridge) => Promise<DesktopUpdateState>) => {
      if (desktop === undefined) return
      const state = await action(desktop)
      setSupport((current) => current && { ...current, state })
    },
    [desktop],
  )
  const download = useCallback(() => apply((desktop) => desktop.download()), [apply])
  const cancel = useCallback(() => apply((desktop) => desktop.cancel()), [apply])
  const install = useCallback(() => apply((desktop) => desktop.install()), [apply])
  if (support === undefined) return undefined
  return { ...support, download, cancel, install }
}
