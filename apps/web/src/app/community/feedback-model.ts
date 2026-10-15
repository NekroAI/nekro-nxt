import { useEffect, useMemo, useRef, useState } from 'react'
import { createOwnedHostQuery, type HostQueryState } from '../../owned-host-query.js'
import { useProductRuntime, useProductStore } from '../../product-runtime.js'
import type { CommunityState } from './community-model.js'

const emptySummary = { enabled: false, signedIn: false, pendingDrafts: 0, unread: 0 } as const
export const useFeedbackSummary = () => useProductStore((state) => state.communityFeedback ?? emptySummary)
export const feedbackScope = (community: CommunityState): string =>
  JSON.stringify([
    community.status?.communityUrl,
    community.status?.account?.id ?? community.status?.account?.handle ?? null,
  ])

/** Cancels old identity reads and clears their data before rendering the newly selected community/account. */
export function useFeedbackQuery<T>(scope: string, read: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const runtime = useProductRuntime()
  const reader = useRef(read)
  reader.current = read
  const currentScope = useRef(scope)
  currentScope.current = scope
  const [state, setState] = useState<HostQueryState<T> & { scope: string }>({
    scope,
    loading: enabled,
    error: '',
    data: undefined,
  })
  const owner = useMemo(
    () =>
      createOwnedHostQuery(
        (signal) => reader.current(signal),
        (patch) => {
          if (currentScope.current === scope) setState((previous) => ({ ...previous, ...patch, scope }))
        },
      ),
    [scope, runtime],
  )
  useEffect(() => {
    setState({ scope, loading: enabled, error: '', data: undefined })
    if (enabled) void owner.load().catch(() => undefined)
    return () => owner.cancel()
  }, [owner, enabled])
  return {
    data: enabled && state.scope === scope ? state.data : undefined,
    error: enabled && state.scope === scope ? state.error : '',
    loading: enabled && (state.scope !== scope || state.loading),
    refresh: owner.load,
    replace: (data: T) => owner.replace(data),
  }
}

export const feedbackVersionReached = (current: string | undefined, fixedIn: string | null | undefined): boolean => {
  if (!current || !fixedIn) return false
  if (current === fixedIn) return true
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/u.exec(value)?.slice(1).map(Number)
  const actual = parse(current),
    expected = parse(fixedIn)
  if (!actual || !expected) return false
  for (let index = 0; index < 3; index += 1)
    if (actual[index] !== expected[index]) return actual[index]! > expected[index]!
  return true
}
