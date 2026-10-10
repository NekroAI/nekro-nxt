import { useCallback, useEffect, useState } from 'react'
import type { ProductUpdateStatus } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'

/** The host checks GitHub itself every few hours; the page only reads the cached result now and then. */
const REFRESH_MS = 30 * 60 * 1000

/** The host's version and whether a newer release exists on its channel; shared by the status bar and About. */
export function useProductUpdates(): {
  readonly status: ProductUpdateStatus | undefined
  readonly checking: boolean
  readonly checkNow: () => Promise<void>
  readonly setAutoCheck: (autoCheck: boolean) => Promise<void>
} {
  const [status, setStatus] = useState<ProductUpdateStatus | undefined>()
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      workspaceApi
        .getProductUpdates({ signal: controller.signal })
        .then(setStatus)
        .catch(() => undefined)
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])
  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await workspaceApi.checkProductUpdates())
    } finally {
      setChecking(false)
    }
  }, [])
  const setAutoCheck = useCallback(async (autoCheck: boolean) => {
    setStatus(await workspaceApi.updateProductUpdateSettings({ autoCheck }))
  }, [])
  return { status, checking, checkNow, setAutoCheck }
}

const channelName: Record<ProductUpdateStatus['channel'], string> = {
  stable: '正式版',
  preview: '预览版',
  development: '开发版本',
}

/** `0.4.0`, `预览 c920874` or `开发版本`: what the build is, in the fewest words. */
export const versionLabel = (status: ProductUpdateStatus): string =>
  status.channel === 'stable'
    ? `v${status.currentVersion}`
    : status.channel === 'preview'
      ? `预览 ${status.currentCommit ?? ''}`.trim()
      : '开发版本'

export const versionDescription = (status: ProductUpdateStatus): string =>
  status.channel === 'development'
    ? '开发版本'
    : `${status.currentVersion}（${channelName[status.channel]}${status.currentCommit ? ` · ${status.currentCommit}` : ''}）`

export const updateLabel = (status: ProductUpdateStatus): string =>
  status.channel === 'preview' ? '预览版有更新' : `${status.latest?.version ?? '新版本'} 可更新`
