import {
  communityPublisherLabel,
  communityReviewLabel,
  HostApiContracts,
  type CommunityInstalledItem,
} from '@nekro-nxt/contracts'
import { PackageCheck, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  ExtensionIcon,
  MainContent,
  ObjectHeader,
  Skeleton,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useGo } from '../model/nav.js'
import { errorMessage } from './community-model.js'
import type { PendingCommunityImport } from './community-space.js'
import styles from './community.module.css'

type Installed = { readonly checkedAt: number | null; readonly items: readonly CommunityInstalledItem[] }

/** 从社区安装的扩展：显示来源、新发布与作者撤回、管理员下架；更新是导入新的保存记录，不自动切换。 */
export function InstalledView({
  onInspected,
  onChecked,
}: {
  readonly onInspected: (pending: PendingCommunityImport) => void
  readonly onChecked: () => void
}) {
  const navigate = useGo()
  const extensions = useProductStore((state) => state.extensions)
  const localIcons = new Map(extensions.map((extension) => [extension.id, extension.iconUrl]))
  const [installed, setInstalled] = useState<Installed>()
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState<string>()

  const load = async (refresh: boolean) => {
    setChecking(refresh)
    try {
      setInstalled(
        await callHostApi(HostApiContracts.listCommunityInstalled, refresh ? { refresh: '1' } : {}, undefined),
      )
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

  const update = async (item: CommunityInstalledItem) => {
    if (!item.latest) return
    setImporting(item.extensionId)
    try {
      const inspection = await callHostApi(
        HostApiContracts.importCommunityRelease,
        { releaseId: item.latest.id },
        undefined,
      )
      onInspected({
        inspection,
        publisher: item.source.publisherHandle,
        status: item.latest.reviewStatus,
        addedPermissions: item.addedPermissions,
      })
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setImporting(undefined)
    }
  }

  const updates = installed?.items.filter((item) => item.updateAvailable).length ?? 0
  return (
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph}>
            <PackageCheck size={20} />
          </span>
        }
        title="已安装"
        meta={
          <span>
            {installed?.checkedAt ? `${relativeTime(installed.checkedAt)}检查` : '从社区安装的扩展'}
            {updates > 0 ? ` · ${updates} 个有新发布` : ''}
          </span>
        }
        actions={
          <Button size="small" icon={<RefreshCw size={14} />} busy={checking} onClick={() => void load(true)}>
            检查更新
          </Button>
        }
      />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {installed === undefined && !error ? (
        <Skeleton height={120} />
      ) : installed && installed.items.length === 0 ? (
        <EmptyState
          icon={<PackageCheck size={22} />}
          title="还没有从社区安装扩展"
          action={
            <Button size="small" onClick={() => navigate('/community')}>
              去发现
            </Button>
          }
        >
          在「发现」中挑选扩展，安装后会出现在这里，有新发布时会提醒你。
        </EmptyState>
      ) : (
        <div className={styles.cardList}>
          {installed?.items.map((item, index) => {
            const label = item.latest ? communityReviewLabel(item.latest.reviewStatus) : undefined
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
                    {item.updateAvailable ? <Chip tone="accent">有新发布</Chip> : null}
                    {item.releaseWithdrawn ? <Chip tone="warn">作者已撤回这次发布</Chip> : null}
                    {item.delisted ? <Chip tone="bad">已从社区下架</Chip> : null}
                    {!item.sameCommunity ? <Chip>来自其他社区地址</Chip> : null}
                  </div>
                  <span className={styles.itemMeta}>
                    来自 {communityPublisherLabel(item.source.publisherHandle)} ·{' '}
                    {relativeTime(item.source.installedAt)}安装
                    {item.updateAvailable && item.latest ? ` · 新发布于${relativeTime(item.latest.createdAt)}` : ''}
                    {item.updateAvailable && label ? ` · ${label.label}` : ''}
                  </span>
                  {item.updateAvailable && item.addedPermissions.length > 0 ? (
                    <span className={styles.itemMeta}>
                      新增权限：{item.addedPermissions.map((permission) => permission.label).join('、')}
                    </span>
                  ) : null}
                  {item.delisted && item.delistedReason ? (
                    <span className={styles.itemMeta}>下架原因：{item.delistedReason}</span>
                  ) : null}
                  {!item.sameCommunity ? (
                    <span className={styles.itemMeta}>
                      来源 {item.source.communityUrl}，切换到该地址后才能检查更新。
                    </span>
                  ) : null}
                </div>
                <div className={styles.itemActions}>
                  {item.sameCommunity && item.found && !item.delisted ? (
                    <Link to={`/community/extensions/${item.extensionId}`} className={styles.textLink}>
                      社区页面
                    </Link>
                  ) : null}
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => navigate(`/workshop/extensions/${item.extensionId}`)}
                  >
                    打开扩展
                  </Button>
                  {item.updateAvailable ? (
                    <Button
                      size="small"
                      variant="primary"
                      busy={importing === item.extensionId}
                      onClick={() => void update(item)}
                    >
                      导入新发布
                    </Button>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
      {updates > 0 ? (
        <p className={styles.faint}>
          导入新发布会成为这个扩展的一条新保存记录，智能体仍使用原来的保存，确认无误后再在扩展详情中切换。
        </p>
      ) : null}
    </MainContent>
  )
}
