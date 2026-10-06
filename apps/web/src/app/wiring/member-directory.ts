import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { useProductStore } from '../../product-runtime.js'
import { useProductApi } from '../model/store.js'

type Response = HostApiResponse<'listPlatformUsers'>
export type Member = Response['items'][number]

export interface MemberPage {
  readonly items: readonly Member[]
  readonly total: number
  readonly nextCursor?: string
}

export type ListMembers = (input: {
  readonly connectionId: string
  readonly query?: string
  readonly cursor?: string
  readonly limit: number
}) => Promise<Response>

export const MEMBER_PAGE_SIZE = 30
/** The Host caps one page at 100 members. */
const MAX_LIMIT = 100

/**
 * Reads the first `count` members of one query again, in pages the Host accepts. Used after the directory changes
 * so the rows already shown stay shown (and the list keeps its scroll position).
 */
export async function reloadMembers(
  list: ListMembers,
  base: { readonly connectionId: string; readonly query?: string },
  count: number,
): Promise<MemberPage> {
  const items: Member[] = []
  let cursor: string | undefined
  let total = 0
  do {
    const page = await list({
      ...base,
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(MAX_LIMIT, Math.max(MEMBER_PAGE_SIZE, count - items.length)),
    })
    items.push(...page.items)
    total = page.total
    cursor = page.nextCursor
  } while (cursor !== undefined && items.length < count)
  return { items, total, ...(cursor === undefined ? {} : { nextCursor: cursor }) }
}

/**
 * One connection's members: a search query, pages loaded on demand, and a refresh of the loaded pages whenever the
 * Host reports a directory change. Changing the query starts again from the first page.
 */
export function useMemberDirectory(connectionId: string) {
  const api = useProductApi()
  const revision = useProductStore((state) => state.platformUsersRevision)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<MemberPage | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // Responses for an older connection or query are dropped.
  const generation = useRef(0)
  const loaded = useRef(0)
  loaded.current = page?.items.length ?? 0

  const list = useCallback<ListMembers>((input) => api.getState().listPlatformUsers(input), [api])
  const base = useCallback(
    () => ({ connectionId, ...(query.trim() ? { query: query.trim() } : {}) }),
    [connectionId, query],
  )

  // Another account's members must not linger; a new query replaces results when they arrive instead.
  useEffect(() => setPage(null), [connectionId])
  useEffect(() => {
    const current = ++generation.current
    const timer = window.setTimeout(() => {
      reloadMembers(list, base(), MEMBER_PAGE_SIZE)
        .then((next) => current === generation.current && setPage(next))
        .catch(() => undefined)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [base, list])

  const firstRevision = useRef(revision)
  useEffect(() => {
    if (revision === firstRevision.current) return
    const current = generation.current
    reloadMembers(list, base(), Math.max(MEMBER_PAGE_SIZE, loaded.current))
      .then((next) => current === generation.current && setPage(next))
      .catch(() => undefined)
    // Only a directory change triggers this; query changes are handled above.
  }, [revision])

  const loadMore = async () => {
    const cursor = page?.nextCursor
    if (cursor === undefined || loadingMore) return
    const current = generation.current
    setLoadingMore(true)
    try {
      const next = await list({ ...base(), cursor, limit: MEMBER_PAGE_SIZE })
      if (current !== generation.current) return
      setPage((previous) => ({
        items: [...(previous?.items ?? []), ...next.items],
        total: next.total,
        ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }),
      }))
    } finally {
      setLoadingMore(false)
    }
  }

  return { query, setQuery, page, loadingMore, loadMore }
}
