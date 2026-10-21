import {
  HostApiContracts,
  type CommandAccountUsage,
  type LinkedAccountsView,
  type LinkedAccountView,
} from '@nekro-nxt/contracts'
import { useCallback, useEffect, useState } from 'react'
import { callHostApi, StaleHostReadError } from '../host-api-client.js'

export type LinkedPlatformView = LinkedAccountsView['platforms'][number]

/**
 * Linked accounts as 设置 → 关联账号 and an agent's capabilities read them. Each user loads its own copy when it
 * mounts; a change returns the new view, which the caller passes to `replace`.
 */
export function useLinkedAccounts(enabled = true) {
  const [view, setView] = useState<LinkedAccountsView>()
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const next = await callHostApi(HostApiContracts.getLinkedAccounts, {}, undefined)
      setView(next)
      setError('')
      return next
    } catch (cause) {
      if (!(cause instanceof StaleHostReadError)) setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }, [])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])
  return { view, error, load, replace: setView }
}

/** What a granted account is meant for; told to the agent only (命令账号授权 A7). */
export const ACCOUNT_USAGES: readonly { readonly value: CommandAccountUsage; readonly label: string }[] = [
  { value: 'read', label: '查看内容' },
  { value: 'issues', label: '处理 issue' },
  { value: 'pull-requests', label: '处理 PR' },
  { value: 'push', label: '推送代码' },
]

/** Token scopes as the platform reports them; a fine-grained token reports none, its own settings decide. */
export const accountScopesText = (account: LinkedAccountView, platformName: string): string =>
  account.scopes === null
    ? `由 ${platformName} 上这个 token 的设置决定`
    : account.scopes.length === 0
      ? '没有额外权限'
      : account.scopes.join('、')

export const ACCOUNT_SOURCE_LABEL: Record<LinkedAccountView['source'], string> = {
  token: '填写的 token',
  'gh-login': '本机 gh 登录',
}
