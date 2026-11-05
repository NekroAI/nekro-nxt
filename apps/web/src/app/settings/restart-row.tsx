import { useEffect, useRef, useState } from 'react'
import type { HostRestartStatus } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { useProductRuntime } from '../../product-runtime.js'
import { Button, ConfirmDialog, PropertyRow, toast } from '../../ui-kit/index.js'

const POLL_MS = 1_000

const answersReady = async (): Promise<boolean> => {
  try {
    const response = await fetch('/health/ready', { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Waits until the service has gone away and answers again. A service that never stops or never comes back within
 * several times the estimate counts as not back.
 */
const waitForReturn = async (estimatedSeconds: number, isLive: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + Math.max(estimatedSeconds * 4, 120) * 1_000
  let stopped = false
  while (Date.now() < deadline && isLive()) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const ready = await answersReady()
    if (!ready) stopped = true
    else if (stopped) return true
  }
  return false
}

type Phase =
  { readonly kind: 'idle' } | { readonly kind: 'restarting'; readonly seconds: number } | { readonly kind: 'late' }

/**
 * Settings → 关于 → 重启服务 (#123). The service stops the way it does on quit; Desktop starts it again, a container
 * comes back through its restart policy. The page reconnects once the service answers again.
 */
export function HostRestartRow() {
  const { store } = useProductRuntime()
  const [status, setStatus] = useState<HostRestartStatus>()
  const [confirming, setConfirming] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const live = useRef(true)
  useEffect(() => {
    const controller = new AbortController()
    live.current = true
    void workspaceApi
      .getHostRestart({ signal: controller.signal })
      .then(setStatus)
      .catch(() => undefined)
    return () => {
      live.current = false
      controller.abort()
    }
  }, [])
  if (status?.supported !== true) return null

  const restart = async () => {
    const { estimatedSeconds } = await workspaceApi.restartHost()
    setPhase({ kind: 'restarting', seconds: estimatedSeconds })
    void waitForReturn(estimatedSeconds, () => live.current).then(async (back) => {
      if (!live.current) return
      if (!back) {
        setPhase({ kind: 'late' })
        return
      }
      setPhase({ kind: 'idle' })
      await store
        .getState()
        .refreshHost()
        .catch(() => undefined)
      toast('服务已重启')
    })
  }

  const description =
    phase.kind === 'restarting'
      ? `正在重启，大约需要 ${phase.seconds} 秒`
      : phase.kind === 'late'
        ? '服务还没有恢复，请检查它的运行环境。'
        : undefined
  return (
    <>
      <PropertyRow label="服务" {...(description === undefined ? {} : { description })}>
        <Button size="small" busy={phase.kind === 'restarting'} onClick={() => setConfirming(true)}>
          重启服务
        </Button>
      </PropertyRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="重启服务"
        confirmLabel="重启"
        onConfirm={restart}
      >
        <p>大约需要 {status.estimatedSeconds} 秒，期间智能体不会回复。</p>
        {status.hostKind === 'server' ? (
          <p>需要容器配置了重启策略（例如 restart: unless-stopped），否则服务停止后不会自动启动。</p>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
