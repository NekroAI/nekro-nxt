import type { HostApiResponse } from '@nekro-nxt/contracts'
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore } from '../product-store.js'
import { Button, Field, Input, SelectField, Spinner } from '../ui-kit/index.js'
import styles from './product-pages.module.css'

type PlatformUser = HostApiResponse<'listPlatformUsers'>['items'][number]

const channelLabel = (channel: PlatformUser['channelPreview'][number]): string =>
  channel.displayName?.trim() ||
  (channel.kind === 'group' ? '未命名群聊' : channel.kind === 'direct' ? '未命名私聊' : '未命名内置频道')

export function UsersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const revision = useProductStore((state) => state.platformUsersRevision)
  const facets = useProductStore((state) => state.platformUserFacets)
  const adapterKey = searchParams.get('adapter') ?? ''
  const connectionId = searchParams.get('connection') ?? ''
  const query = searchParams.get('query') ?? ''
  const [queryDraft, setQueryDraft] = useState(query)
  const [items, setItems] = useState<readonly PlatformUser[]>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => setQueryDraft(query), [query])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (queryDraft === query) return
      const next = new URLSearchParams(searchParams)
      if (queryDraft.trim()) next.set('query', queryDraft.trim())
      else next.delete('query')
      setSearchParams(next, { replace: true })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [queryDraft, query, searchParams, setSearchParams])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(
      () => {
        setLoading(true)
        setError('')
        void useProductStore
          .getState()
          .listPlatformUsers({
            ...(query ? { query } : {}),
            ...(adapterKey ? { adapterKey } : {}),
            ...(connectionId ? { connectionId } : {}),
            limit: 50,
          })
          .then((result) => {
            if (!active) return
            setItems(result.items)
            setTotal(result.total)
            setNextCursor(result.nextCursor)
          })
          .catch((cause: unknown) => {
            if (active) setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (active) setLoading(false)
          })
      },
      revision === 0 ? 0 : 220,
    )
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [adapterKey, connectionId, query, revision])

  const selectedAdapter = facets.adapters.find((adapter) => adapter.key === adapterKey)
  const connectionOptions = facets.connections
    .filter((connection) => !adapterKey || connection.adapterKey === adapterKey)
    .map((connection) => ({ value: connection.id, label: `${connection.displayName}（${connection.userCount}）` }))
  const hasFilters = Boolean(adapterKey || connectionId || query)
  const historicalOnly = items.length > 0 && items.every((item) => item.historicalOnly)

  const updateFilter = (key: 'adapter' | 'connection', value: string): void => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'adapter') next.delete('connection')
    setSearchParams(next, { replace: true })
  }

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError('')
    try {
      const result = await useProductStore.getState().listPlatformUsers({
        ...(query ? { query } : {}),
        ...(adapterKey ? { adapterKey } : {}),
        ...(connectionId ? { connectionId } : {}),
        cursor: nextCursor,
        limit: 50,
      })
      setItems((current) => [...current, ...result.items])
      setTotal(result.total)
      setNextCursor(result.nextCursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  const renderRows = (users: readonly PlatformUser[]) => (
    <div className={styles.userRows} role="rowgroup">
      {users.map((user) => (
        <article className={styles.userRow} key={user.identityId} role="row">
          <span className={styles.userAvatar} aria-hidden="true">
            {(user.displayName?.trim() || '用').slice(0, 1)}
          </span>
          <span className={styles.userIdentity} role="cell">
            <strong>{user.displayName?.trim() || '未命名用户'}</strong>
            <small>{user.historicalOnly ? '仅保留历史身份' : `${user.activeChannelCount} 个活动频道`}</small>
          </span>
          <span className={styles.userConnection} role="cell">
            <strong>{user.connection.displayName}</strong>
            <small>{user.adapter.displayName}</small>
          </span>
          <span className={styles.userChannels} role="cell">
            {user.historicalOnly ? (
              <em>
                <History size={13} aria-hidden="true" /> 仅历史记录
              </em>
            ) : (
              <>
                <strong>{user.activeChannelCount} 个活动频道</strong>
                <small>
                  {user.channelPreview.map(channelLabel).join('、')}
                  {user.activeChannelCount > user.channelPreview.length ? ' 等' : ''}
                </small>
              </>
            )}
          </span>
        </article>
      ))}
    </div>
  )

  return (
    <div className={[styles.page, styles.desktopPage, styles.usersPage].join(' ')} data-product-page="users">
      <PageHeader
        quiet
        title="平台用户"
        meta={
          <span>
            {selectedAdapter ? `${selectedAdapter.displayName} · ` : ''}
            {loading ? '正在更新目录' : `${total} 位用户`}
          </span>
        }
      />
      <section className={styles.userToolbar} aria-label="用户筛选" data-page-toolbar="">
        <div className={styles.userToolbarFields}>
          <Field label="搜索名称">
            <Input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="输入平台显示名"
            />
          </Field>
          <SelectField
            label="平台"
            value={adapterKey || 'all'}
            onValueChange={(value) => updateFilter('adapter', value === 'all' ? '' : value)}
            options={[
              { value: 'all', label: '全部平台' },
              ...facets.adapters.map((adapter) => ({ value: adapter.key, label: adapter.displayName })),
            ]}
          />
          <SelectField
            label="平台连接"
            value={connectionId || 'all'}
            onValueChange={(value) => updateFilter('connection', value === 'all' ? '' : value)}
            options={[{ value: 'all', label: '全部连接' }, ...connectionOptions]}
          />
        </div>
        <div className={styles.userToolbarActions}>
          <Button
            variant="ghost"
            disabled={!hasFilters}
            onClick={() => {
              setQueryDraft('')
              setSearchParams({}, { replace: true })
            }}
          >
            清除筛选
          </Button>
        </div>
      </section>
      <section className={styles.userWorkspace} aria-label="用户目录">
        <div className={styles.userNotices} aria-live="polite">
          {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
          {historicalOnly ? (
            <InlineFeedback tone="warning">当前结果仅包含历史记录；这些用户目前不在任何活动频道中。</InlineFeedback>
          ) : null}
        </div>
        <div className={styles.userTable} role="table" aria-label="平台用户" aria-rowcount={total}>
          <div className={styles.userTableHeader} role="row" data-table-header="">
            <span aria-hidden="true" />
            <span role="columnheader">用户</span>
            <span role="columnheader">平台连接</span>
            <span role="columnheader">活动范围</span>
          </div>
          <div className={styles.userTableBody} data-table-scroll-region="">
            {loading && items.length === 0 ? (
              <EmptyState loading title="正在读取用户目录" description="正在汇总已持久化的平台身份。" />
            ) : items.length === 0 ? (
              <EmptyState
                title={hasFilters ? '当前筛选无结果' : '尚未观测到用户'}
                description={
                  hasFilters ? '调整名称、平台或连接筛选条件。' : '收到平台成员消息后，对应身份会出现在这里。'
                }
              />
            ) : (
              renderRows(items)
            )}
          </div>
        </div>
        <footer className={styles.userPagination} data-table-pagination="">
          <span>
            已显示 {items.length} / {total}
          </span>
          {nextCursor ? (
            <Button onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <Spinner /> : null}
              {loadingMore ? '正在加载' : '加载更多'}
            </Button>
          ) : (
            <span>已加载全部</span>
          )}
        </footer>
      </section>
    </div>
  )
}
