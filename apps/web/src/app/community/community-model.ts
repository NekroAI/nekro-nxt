import { useCallback, useEffect, useRef, useState } from 'react'
import { HostApiContracts, type CommunityEnvironment, type CommunityStatus } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'

const LOGIN_WAIT_MS = 10 * 60_000
const LOGIN_POLL_MS = 2_000

/**
 * 社区账号状态。登录在社区页面完成（Desktop 中是系统浏览器），回到本页时重新读取；
 * 发起登录后短时轮询，直到看到账号或超时。
 */
export const useCommunityStatus = (enabled = true) => {
  const [status, setStatus] = useState<CommunityStatus>()
  const [error, setError] = useState<string>()
  const [waiting, setWaiting] = useState(false)
  const deadline = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const next = await callHostApi(HostApiContracts.getCommunityStatus, {}, undefined)
      setStatus(next)
      setError(undefined)
      if (next.account !== null) setWaiting(false)
      return next
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return undefined
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, refresh])

  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => {
      if (Date.now() > deadline.current) {
        setWaiting(false)
        return
      }
      void refresh()
    }, LOGIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [waiting, refresh])

  const signIn = useCallback(async () => {
    const { authorizeUrl } = await callHostApi(
      HostApiContracts.startCommunityLogin,
      {},
      { returnOrigin: window.location.origin },
    )
    // Desktop 把新窗口交给系统浏览器；普通浏览器打开新标签页。
    window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
    deadline.current = Date.now() + LOGIN_WAIT_MS
    setWaiting(true)
  }, [])

  const signOut = useCallback(async () => {
    setStatus(await callHostApi(HostApiContracts.communityLogout, {}, undefined))
  }, [])

  return { status, error, waiting, refresh, signIn, signOut, cancelWaiting: () => setWaiting(false) }
}

export const openExternal = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export const ENVIRONMENT_LABEL: Readonly<Record<CommunityEnvironment, string>> = {
  production: '正式社区',
  staging: '测试站',
  development: '开发站',
}

export type CommunityState = ReturnType<typeof useCommunityStatus>

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
