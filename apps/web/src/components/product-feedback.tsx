import { AlertCircle, Inbox, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useProductStore } from '../product-store.js'
import { Button } from '../ui-kit/index.js'
import styles from './product-feedback.module.css'

export async function runHostRefresh(
  refreshHost: () => Promise<void>,
  setPending: (pending: boolean) => void,
  setError: (message: string) => void,
): Promise<void> {
  setPending(true)
  setError('')
  try {
    await refreshHost()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  } finally {
    setPending(false)
  }
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  readonly title: string
  readonly meta?: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {meta ? <div className={styles.pageMeta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </header>
  )
}

export function InlineFeedback({
  tone = 'info',
  children,
  role,
}: {
  readonly tone?: 'info' | 'warning' | 'error' | 'success'
  readonly children: ReactNode
  readonly role?: 'alert' | 'status'
}) {
  return (
    <div className={[styles.feedback, styles[tone]].join(' ')} role={role ?? (tone === 'error' ? 'alert' : 'status')}>
      {tone === 'error' ? <AlertCircle size={15} aria-hidden="true" /> : null}
      <div>{children}</div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  loading = false,
}: {
  readonly title: string
  readonly description: string
  readonly action?: ReactNode
  readonly loading?: boolean
}) {
  return (
    <div className={styles.emptyState}>
      {loading ? (
        <LoaderCircle className={styles.spinner} size={22} aria-hidden="true" />
      ) : (
        <Inbox size={24} aria-hidden="true" />
      )}
      <div className={styles.emptyTitle}>{title}</div>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function HostNotice() {
  const host = useProductStore((state) => state.host)
  const [pending, setPending] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const reconnect = async (): Promise<void> => {
    if (pending) return
    await runHostRefresh(() => useProductStore.getState().refreshHost(), setPending, setRefreshError)
  }

  if (host.status === 'ready') return null
  if (host.status === 'initializing') {
    return (
      <div className={[styles.hostNotice, styles.hostConnecting].join(' ')} role="status">
        <LoaderCircle className={styles.spinner} size={15} aria-hidden="true" />
        正在连接，页面会在数据就绪后自动更新。
      </div>
    )
  }

  const stale = host.status === 'stale'
  return (
    <div className={[styles.hostNotice, stale ? styles.hostStale : styles.hostError].join(' ')} role="alert">
      <WifiOff size={15} aria-hidden="true" />
      <span>
        {refreshError
          ? `重新连接失败：${refreshError}`
          : stale
            ? '连接不稳定，当前仍显示最近一次同步的数据。'
            : '无法连接，当前内容可能为空或不是最新状态。'}
      </span>
      <Button size="small" variant="ghost" loading={pending} loadingLabel="连接中…" onClick={() => void reconnect()}>
        <RefreshCw size={14} aria-hidden="true" /> 重新连接
      </Button>
    </div>
  )
}
