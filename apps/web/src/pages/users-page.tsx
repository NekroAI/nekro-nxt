import type { HostApiResponse } from '@nekro-nxt/contracts'
import { History } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore } from '../product-store.js'
import { Button, Field, Input, SelectField, Spinner, StageCrossfade } from '../ui-kit/index.js'
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
  const groups = useMemo(() => {
    if (adapterKey) return []
    const grouped = new Map<string, { displayName: string; users: PlatformUser[] }>()
    for (const user of items) {
      const current = grouped.get(user.adapter.key) ?? { displayName: user.adapter.displayName, users: [] }
      current.users.push(user)
      grouped.set(user.adapter.key, current)
    }
    return [...grouped.entries()]
  }, [adapterKey, items])
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
    <div className={styles.userRows}>
      {users.map((user) => (
        <article className={styles.userRow} key={user.identityId}>
          <span className={styles.userAvatar} aria-hidden="true">
            {(user.displayName?.trim() || '用').slice(0, 1)}
          </span>
          <span className={styles.userIdentity}>
            <strong>{user.displayName?.trim() || '未命名用户'}</strong>
            <small>
              {user.adapter.displayName} · {user.connection.displayName}
            </small>
          </span>
          <span className={styles.userChannels}>
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
    <div className={[styles.page, styles.detailPage, styles.workspacePage].join(' ')}>
      <StageCrossfade className={styles.workspaceStage} swapKey={adapterKey || 'all'}>
        <PageHeader
          className={styles.workspaceHeader}
          quiet
          title={selectedAdapter?.displayName ?? '全部用户'}
          meta={<span>{loading ? '正在更新目录' : `${total} 位用户`}</span>}
        />
        <section className={styles.userToolbar} aria-label="用户筛选">
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
        </section>
        {items.length > 0 ? (
          <div className={styles.userTableHeader} aria-hidden="true" data-user-table-header="">
            <span />
            <span>用户与来源</span>
            <span>频道状态</span>
          </div>
        ) : null}
        <div className={styles.workspaceScroller} data-workspace-scroll="用户目录">
          {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
          {historicalOnly ? (
            <InlineFeedback tone="warning">当前结果仅包含历史记录；这些用户目前不在任何活动频道中。</InlineFeedback>
          ) : null}
          {loading && items.length === 0 ? (
            <EmptyState fill loading title="正在读取用户目录" description="正在汇总已持久化的平台身份。" />
          ) : items.length === 0 ? (
            <EmptyState
              fill
              title={hasFilters ? '当前筛选无结果' : '尚未观测到用户'}
              description={hasFilters ? '调整名称、平台或连接筛选条件。' : '收到平台成员消息后，对应身份会出现在这里。'}
            />
          ) : adapterKey ? (
            renderRows(items)
          ) : (
            <div className={styles.userGroups}>
              {groups.map(([key, group]) => (
                <section key={key} className={styles.userGroup}>
                  <header>
                    <h2>{group.displayName}</h2>
                    <span>{group.users.length} 位</span>
                  </header>
                  {renderRows(group.users)}
                </section>
              ))}
            </div>
          )}
        </div>
        {nextCursor ? (
          <div className={styles.userLoadMore} data-workspace-footer="">
            <Button onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <Spinner /> : null}
              {loadingMore ? '正在加载' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </StageCrossfade>
    </div>
  )
}
