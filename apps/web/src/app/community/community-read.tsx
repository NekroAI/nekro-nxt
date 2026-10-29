import type { CommunityFreshness } from '@nekro-nxt/contracts'
import { CloudOff, History } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { HostRequestError } from '../../host-api-client.js'
import { Button, EmptyState, Skeleton } from '../../ui-kit/index.js'
import { errorMessage } from './community-model.js'
import styles from './community.module.css'

export interface CommunityFailure {
  readonly title: string
  readonly detail?: string
}

/** Why a community read failed, by the cause the instance reported. */
export const communityFailure = (error: unknown): CommunityFailure => {
  if (error instanceof HostRequestError) {
    if (error.code === 'community-unreachable') return { title: '无法连接社区' }
    if (error.code === 'community-timeout') return { title: '社区响应超时' }
    if (error.kind === 'http') return { title: '社区返回错误', detail: error.message }
  }
  return { title: '读取失败', detail: errorMessage(error) }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 「14:05」，不是今天时带上日期：「10月28日 14:05」。 */
export const fetchedLabel = (time: number, now = Date.now()): string => {
  const date = new Date(time)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString()
    ? clock
    : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

/**
 * One community catalog read for a page: the latest result, why it failed when nothing could be shown, and `reload`
 * to read again past the instance's cache. Only the newest request updates the page.
 */
export function useCommunityRead<T extends CommunityFreshness>(
  read: (refresh: boolean) => Promise<T>,
  deps: DependencyList,
  options: { readonly delayMs?: number; readonly keepWhileLoading?: boolean } = {},
) {
  const [data, setData] = useState<T>()
  const [failure, setFailure] = useState<CommunityFailure>()
  const [reloading, setReloading] = useState(false)
  const latest = useRef(0)
  const readRef = useRef(read)
  readRef.current = read

  const run = useCallback((refresh: boolean) => {
    const request = ++latest.current
    if (refresh) setReloading(true)
    return readRef
      .current(refresh)
      .then((result) => {
        if (request !== latest.current) return
        setData(result)
        setFailure(undefined)
      })
      .catch((caught: unknown) => {
        if (request !== latest.current) return
        setFailure(communityFailure(caught))
      })
      .finally(() => {
        if (request === latest.current) setReloading(false)
      })
  }, [])

  useEffect(() => {
    if (!options.keepWhileLoading) setData(undefined)
    setFailure(undefined)
    const timer = window.setTimeout(() => void run(false), options.delayMs ?? 0)
    return () => {
      window.clearTimeout(timer)
      latest.current += 1
    }
  }, deps)

  return { data, setData, failure, reloading, reload: () => void run(true) }
}

/** First read in progress. */
export function CommunityLoading({ height = 96 }: { readonly height?: number }) {
  return (
    <div className={styles.readState} role="status">
      <Skeleton height={height} />
      <span className={styles.faint}>正在读取社区内容…</span>
    </div>
  )
}

/** Nothing to show: the cause and a retry. */
export function CommunityFailureState({
  failure,
  busy,
  onRetry,
}: {
  readonly failure: CommunityFailure
  readonly busy: boolean
  readonly onRetry: () => void
}) {
  return (
    <EmptyState
      icon={<CloudOff size={22} />}
      title={failure.title}
      action={
        <Button size="small" busy={busy} onClick={onRetry}>
          重试
        </Button>
      }
    >
      {failure.detail}
    </EmptyState>
  )
}

/** The community could not be read this time; an earlier copy is shown. */
export function StaleNotice({
  fetchedAt,
  busy,
  onRetry,
}: {
  readonly fetchedAt: number
  readonly busy: boolean
  readonly onRetry: () => void
}) {
  return (
    <p className={styles.staleNotice} role="status">
      <History size={14} aria-hidden="true" />
      <span>显示的是 {fetchedLabel(fetchedAt)} 的内容</span>
      <Button size="small" variant="ghost" busy={busy} onClick={onRetry}>
        重试
      </Button>
    </p>
  )
}
