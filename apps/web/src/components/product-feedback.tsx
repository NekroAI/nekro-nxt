import { AlertCircle, Inbox, RefreshCw, WifiOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useProductStore } from '../product-store.js'
import { Button, Enter, Presence, Spinner } from '../ui-kit/index.js'
import { notify } from './notifications.js'
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
    <Enter
      kind="fade"
      className={[styles.feedback, styles[tone]].join(' ')}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
    >
      {tone === 'error' ? <AlertCircle size={15} aria-hidden="true" /> : null}
      <div>{children}</div>
    </Enter>
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
      {loading ? <Spinner size={22} /> : <Inbox size={24} aria-hidden="true" />}
      <div className={styles.emptyTitle}>{title}</div>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function HostNotice() {
  const host = useProductStore((state) => state.host)
  const [pending, setPending] = useState(false)
  const reconnect = async (): Promise<void> => {
    if (pending) return
    await runHostRefresh(
      () => useProductStore.getState().refreshHost(),
      setPending,
      (message) => {
        if (message) notify(`重新连接失败：${message}`, 'error', 'host-reconnect')
      },
    )
  }

  return (
    <Presence>
      {host.status === 'ready' ? null : host.status === 'initializing' ? (
        <Enter
          kind="fade"
          key="initializing"
          className={[styles.hostNotice, styles.hostConnecting].join(' ')}
          role="status"
        >
          <Spinner delayMs={300} size={15} />
          <strong>正在连接</strong>
          <span>页面会在数据就绪后自动更新。</span>
        </Enter>
      ) : (
        <Enter
          kind="fade"
          key={host.status}
          className={[styles.hostNotice, host.status === 'stale' ? styles.hostStale : styles.hostError].join(' ')}
          role="alert"
        >
          <WifiOff size={15} aria-hidden="true" />
          <strong>{host.status === 'stale' ? '连接不稳定' : '无法连接'}</strong>
          <span>{host.status === 'stale' ? '当前仍显示最近一次同步的数据。' : '当前内容可能为空或不是最新状态。'}</span>
          <Button
            size="small"
            variant="ghost"
            loading={pending}
            loadingLabel="连接中…"
            onClick={() => void reconnect()}
          >
            <RefreshCw size={14} aria-hidden="true" /> 重新连接
          </Button>
        </Enter>
      )}
    </Presence>
  )
}
