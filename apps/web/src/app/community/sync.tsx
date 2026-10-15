import { communityReviewLabel, HostApiContracts, type CommunitySyncItem } from '@nekro-nxt/contracts'
import { RefreshCw, Repeat2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ExtensionIcon,
  MainContent,
  ObjectHeader,
  Skeleton,
  toast,
  type Tone,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useGo } from '../model/nav.js'
import { errorMessage } from './community-model.js'
import styles from './community.module.css'

type Sync = { readonly checkedAt: number | null; readonly items: readonly CommunitySyncItem[] }

/** What a line's state means here, for the one who publishes it and for the one who follows it. */
const describe = (item: CommunitySyncItem): { readonly label: string; readonly tone: Tone; readonly detail: string } => {
  const owner = item.role === 'owner'
  switch (item.status) {
    case 'same':
      return { label: '已同步', tone: 'ok', detail: `本机的 ${item.currentVersionLabel} 就是社区最新发布。` }
    case 'remote-ahead':
      return {
        label: '社区有更新',
        tone: 'accent',
        detail: owner
          ? '社区上有比本机更新的发布（可能来自你的另一台机器）。'
          : '作者发布了新版本，更新后会成为这里的新版本。',
      }
    case 'local-ahead':
      return owner
        ? { label: '可以发布', tone: 'accent', detail: `本机的 ${item.currentVersionLabel} 比社区最新发布更新。` }
        : {
            label: '本机有修改',
            tone: 'neutral',
            detail: '本机在社区版本上做了修改。想分享给别人时，先做成你自己的分支再发布。',
          }
    case 'diverged':
      return {
        label: '两边都有修改',
        tone: 'warn',
        detail: '本机和社区从同一个版本各自改了。可以让智能体把社区的改动合进本机版本，或者保留本机。',
      }
    case 'unrelated':
      return { label: '没有共同版本', tone: 'warn', detail: '本机版本和社区发布不在同一条谱系上。' }
    case 'unknown':
      return { label: '社区上没有', tone: 'neutral', detail: '社区上找不到这个扩展，可能还没有发布或已被删除。' }
  }
}

/**
 * Every extension line this machine follows or publishes on the current community: whether the local version and
 * the newest release are the same, which one is ahead, or whether both changed. Updating imports the release as the
 * next local version and switches to it.
 */
export function SyncView({ onChecked }: { readonly onChecked: () => void }) {
  const navigate = useGo()
  const extensions = useProductStore((state) => state.extensions)
  const localIcons = new Map(extensions.map((extension) => [extension.id, extension.iconUrl]))
  const [sync, setSync] = useState<Sync>()
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [confirming, setConfirming] = useState<CommunitySyncItem>()

  const load = async (refresh: boolean) => {
    setChecking(refresh)
    try {
      setSync(await callHostApi(HostApiContracts.listCommunitySync, refresh ? { refresh: '1' } : {}, undefined))
      setError(undefined)
      onChecked()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void load(false)
  }, [])

  const update = async (item: CommunitySyncItem) => {
    setBusy(item.extensionId)
    try {
      const result = await callHostApi(HostApiContracts.updateFromCommunity, { extensionId: item.extensionId }, undefined)
      toast(result.message)
      await load(true)
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setBusy(undefined)
    }
  }
  const dismiss = async (item: CommunitySyncItem, releaseId: string | null) => {
    setBusy(item.extensionId)
    try {
      await callHostApi(HostApiContracts.dismissCommunityRelease, { extensionId: item.extensionId }, { releaseId })
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setBusy(undefined)
    }
  }

  const attention = sync?.items.filter(
    (item) => !item.dismissed && (item.status === 'remote-ahead' || item.status === 'diverged'),
  ).length
  return (
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph}>
            <Repeat2 size={20} />
          </span>
        }
        title="同步"
        meta={
          <span>
            {sync?.checkedAt ? `${relativeTime(sync.checkedAt)}检查` : '本机安装和发布的社区扩展'}
            {attention ? ` · ${attention} 个需要处理` : ''}
          </span>
        }
        actions={
          <Button size="small" icon={<RefreshCw size={14} />} busy={checking} onClick={() => void load(true)}>
            检查更新
          </Button>
        }
      />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {sync === undefined && !error ? (
        <Skeleton height={120} />
      ) : sync && sync.items.length === 0 ? (
        <EmptyState
          icon={<Repeat2 size={22} />}
          title="还没有和社区同步的扩展"
          action={
            <Button size="small" onClick={() => navigate('/community')}>
              去发现
            </Button>
          }
        >
          从社区安装或发布到社区的扩展会出现在这里，有新发布或本机有修改时会标出来。
        </EmptyState>
      ) : (
        <div className={styles.cardList}>
          {sync?.items.map((item, index) => {
            const state = describe(item)
            const review = item.latest ? communityReviewLabel(item.latest.reviewStatus) : undefined
            const latestNumber = item.latest?.number === undefined ? '' : ` #${item.latest.number}`
            return (
              <article key={item.extensionId} className={styles.item} style={{ ['--i' as string]: index }}>
                <ExtensionIcon
                  id={item.extensionId}
                  name={item.displayName}
                  iconUrl={localIcons.get(item.extensionId)}
                  size="lg"
                />
                <div className={styles.itemBody}>
                  <div className={styles.itemTitle}>
                    {item.displayName}
                    <Chip tone={item.dismissed ? 'neutral' : state.tone}>
                      {item.dismissed ? '已保留本机' : state.label}
                    </Chip>
                    {item.role === 'owner' ? <Chip>我发布的</Chip> : null}
                    {item.releaseWithdrawn ? <Chip tone="warn">作者已撤回本机这次发布</Chip> : null}
                    {item.delisted ? <Chip tone="bad">已从社区下架</Chip> : null}
                  </div>
                  <span className={styles.itemMeta}>{state.detail}</span>
                  <span className={styles.itemMeta}>
                    本机 {item.currentVersionLabel}
                    {item.currentRelease?.number ? `（发布 #${item.currentRelease.number}）` : ''}
                    {item.latest ? ` · 社区最新发布${latestNumber}，${relativeTime(item.latest.createdAt)}` : ''}
                    {item.latest && review && item.status !== 'same' ? ` · ${review.label}` : ''}
                  </span>
                  {item.status === 'remote-ahead' && item.addedPermissions.length > 0 ? (
                    <span className={styles.itemMeta}>
                      新发布新增权限：{item.addedPermissions.map((permission) => permission.label).join('、')}
                    </span>
                  ) : null}
                  {item.delisted && item.delistedReason ? (
                    <span className={styles.itemMeta}>下架原因：{item.delistedReason}</span>
                  ) : null}
                </div>
                <div className={styles.itemActions}>
                  {item.found && !item.delisted ? (
                    <Link to={`/community/extensions/${item.extensionId}`} className={styles.textLink}>
                      社区页面
                    </Link>
                  ) : null}
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => navigate(`/workshop/extensions/${item.extensionId}`)}
                  >
                    {item.status === 'local-ahead' || item.status === 'diverged' ? '查看谱系' : '打开扩展'}
                  </Button>
                  {item.dismissed ? (
                    <Button
                      size="small"
                      variant="ghost"
                      busy={busy === item.extensionId}
                      onClick={() => void dismiss(item, null)}
                    >
                      重新提醒
                    </Button>
                  ) : item.status === 'diverged' && item.latest ? (
                    <Button
                      size="small"
                      variant="ghost"
                      busy={busy === item.extensionId}
                      onClick={() => void dismiss(item, item.latest!.id)}
                    >
                      保留本机
                    </Button>
                  ) : null}
                  {!item.dismissed && (item.status === 'remote-ahead' || item.status === 'diverged') ? (
                    <Button
                      size="small"
                      variant={item.status === 'remote-ahead' ? 'primary' : 'default'}
                      busy={busy === item.extensionId}
                      onClick={() => setConfirming(item)}
                    >
                      {item.status === 'remote-ahead' ? '更新' : '改用社区版本'}
                    </Button>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => !open && setConfirming(undefined)}
        title={confirming?.status === 'diverged' ? '改用社区版本？' : `更新「${confirming?.displayName ?? ''}」？`}
        confirmLabel={confirming?.status === 'diverged' ? '改用社区版本' : '更新'}
        onConfirm={() => (confirming ? update(confirming) : undefined)}
      >
        {confirming?.status === 'diverged'
          ? '社区的发布会作为新版本导入并切换过去，所有在用的智能体一起切换。本机的修改留在原来的版本里，之后还能切回或让智能体合并。'
          : '社区的发布会作为新版本导入并切换过去，所有在用的智能体一起切换；需要时可以在扩展详情里回滚。'}
        {confirming && confirming.addedPermissions.length > 0
          ? `新发布新增权限：${confirming.addedPermissions.map((permission) => permission.label).join('、')}。确认即同意这些权限。`
          : ''}
      </ConfirmDialog>
    </MainContent>
  )
}
