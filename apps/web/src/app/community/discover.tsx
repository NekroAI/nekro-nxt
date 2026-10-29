import {
  COMMUNITY_EXTENSION_SORTS,
  communityReviewLabel,
  EXTENSION_SDK_LEVEL,
  extensionSdkVersion,
  HostApiContracts,
  type CommunityExtensionSort,
  type CommunityExtensionDetail,
  type CommunityExtensionSummary,
  type CommunityReviewStatus,
  type CommunitySyncItem,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { ArrowLeft, Code2, ExternalLink, RefreshCw, Store } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useGo } from '../model/nav.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  ExtensionIcon,
  MainContent,
  ObjectHeader,
  PageHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SearchField,
  Select,
  TabStrip,
  ToggleChip,
  toast,
  spotlight,
} from '../../ui-kit/index.js'
import { MarkdownDocument } from '../../components/markdown-document.js'
import { relativeTime } from '../channels/timeline-model.js'
import { RatingCard, RatingMark } from './community-rating.js'
import { openExternal, publisherName } from './community-model.js'
import { CommunityFailureState, CommunityLoading, StaleNotice, useCommunityRead } from './community-read.js'
import { providesLabel } from '../workshop/workshop-model.js'
import { useCommunityUpdates } from '../workshop/updates-view.js'
import styles from './community.module.css'

type Inspection = HostApiResponse<'inspectExtensionImport'>
type Provides = '' | 'agent' | 'page' | 'adapter' | 'mcp'

const PROVIDES: readonly { readonly value: Provides; readonly label: string }[] = [
  { value: '', label: '全部' },
  { value: 'agent', label: '智能体能力' },
  { value: 'page', label: '页面' },
  { value: 'adapter', label: '平台适配' },
]

const LEVEL_LABEL = { normal: '常规', elevated: '需留意', high: '高风险' } as const
const LEVEL_TONE = { normal: 'neutral', elevated: 'warn', high: 'bad' } as const

/** Older community releases have no layer; their items were all agent-layer capabilities. */
const PERMISSION_LAYERS = {
  host: { title: '本机权限', description: '安装到本机时确认，对整台机器生效。' },
  agent: { title: '智能体权限', description: '给智能体启用时确认，只对该智能体生效。' },
} as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The card keeps to four review words (interaction model §2.6); notes and details stay on the detail page. */
const CARD_REVIEW: Partial<
  Record<CommunityReviewStatus, { readonly tone: 'ok' | 'warn' | 'bad'; readonly label: string }>
> = {
  passed: { tone: 'ok', label: '已审查' },
  passed_with_notes: { tone: 'ok', label: '已审查' },
  flagged: { tone: 'warn', label: '待复审' },
  risk_confirmed: { tone: 'bad', label: '有风险' },
  held: { tone: 'bad', label: '有风险' },
  rejected: { tone: 'bad', label: '有风险' },
}

const ReviewChip = ({ status }: { readonly status: CommunityExtensionSummary['latest'] }) => {
  const label = status ? CARD_REVIEW[status.reviewStatus] : undefined
  return label ? <Chip tone={label.tone}>{label.label}</Chip> : null
}

const currentVersion = typeof __NEKRO_PRODUCT_VERSION__ === 'string' ? __NEKRO_PRODUCT_VERSION__ : ''

/**
 * What a release needs when this NekroNXT is too old for it: the version that first supports it, or an empty string
 * when even that is newer than this build knows; undefined when it can be installed.
 */
const neededVersion = (requiresSdk: number | null | undefined): string | undefined => {
  if (requiresSdk == null || requiresSdk <= EXTENSION_SDK_LEVEL) return undefined
  return extensionSdkVersion(requiresSdk) ?? ''
}

function UpgradeChip({ requiresSdk }: { readonly requiresSdk: number | null | undefined }) {
  const needs = neededVersion(requiresSdk)
  if (needs === undefined) return null
  return <Chip tone="warn">{needs ? `需 NekroNXT ${needs}` : '需更新 NekroNXT'}</Chip>
}

/** 社区「发现」：扩展目录与详情。安装先下载并校验，再走与本地文件相同的导入确认；导入后不会自动启用。 */
export function CommunityView({
  extensionId,
  onInspected,
}: {
  readonly extensionId: string | undefined
  readonly onInspected: (inspection: Inspection, detail: CommunityExtensionDetail) => void
}) {
  return extensionId ? (
    <CommunityDetail key={extensionId} extensionId={extensionId} onInspected={onInspected} />
  ) : (
    <CommunityCatalog />
  )
}

/** Only a newer community release counts as an update on the cards; diverged lines stay「已安装」. */
const updateOffered = (item: CommunitySyncItem): boolean => !item.dismissed && item.status === 'remote-ahead'

function InstalledChip({ updatable }: { readonly updatable: boolean }) {
  return updatable ? <Chip tone="accent">可更新</Chip> : <Chip>已安装</Chip>
}

function CommunityCatalog() {
  const [query, setQuery] = useState('')
  const [provides, setProvides] = useState<Provides>('')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [sort, setSort] = useState<CommunityExtensionSort>('updated')
  const [loadingMore, setLoadingMore] = useState(false)
  const installedIds = useProductStore((state) => state.extensions.map((item) => item.id).join('\n'))
  const installed = useMemo(() => new Set(installedIds.split('\n')), [installedIds])
  const updatable = useCommunityUpdates(updateOffered)

  const filters = {
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(provides ? { provides } : {}),
    ...(officialOnly ? { official: '1' as const } : {}),
    ...(sort === 'updated' ? {} : { sort }),
  }
  const list = useCommunityRead(
    (refresh) =>
      callHostApi(
        HostApiContracts.listCommunityExtensions,
        { ...filters, ...(refresh ? { refresh: '1' as const } : {}) },
        undefined,
      ),
    [query, provides, officialOnly, sort],
    { delayMs: 250, keepWhileLoading: true },
  )
  const page = list.data
  const items = page?.items

  const loadMore = async () => {
    if (!page?.nextCursor) return
    setLoadingMore(true)
    try {
      const result = await callHostApi(
        HostApiContracts.listCommunityExtensions,
        { ...filters, cursor: page.nextCursor },
        undefined,
      )
      list.setData((current) =>
        current
          ? {
              items: [...current.items, ...result.items],
              nextCursor: result.nextCursor,
              fetchedAt: Math.min(current.fetchedAt, result.fetchedAt),
              stale: current.stale || result.stale,
            }
          : current,
      )
    } catch (caught) {
      toast(message(caught), { tone: 'bad' })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <MainContent width="full">
      <PageHeader
        title="发现"
        subtitle="由社区作者发布，均经过自动审查"
        actions={
          <Button size="small" icon={<RefreshCw size={14} />} busy={list.reloading} onClick={list.reload}>
            刷新
          </Button>
        }
      />
      <TabStrip<Provides> label="提供什么" value={provides} onChange={setProvides} options={PROVIDES} />
      <div className={styles.communityTools}>
        <SearchField value={query} onChange={setQuery} label="搜索社区扩展" placeholder="搜索名称、介绍或标签" />
        <ToggleChip pressed={officialOnly} onPressedChange={setOfficialOnly}>
          只看官方
        </ToggleChip>
        <Select
          aria-label="排序"
          className={styles.sortSelect}
          value={sort}
          onValueChange={(value) => {
            const next = COMMUNITY_EXTENSION_SORTS.find((item) => item.key === value)
            if (next) setSort(next.key)
          }}
          options={COMMUNITY_EXTENSION_SORTS.map(({ key, label }) => ({ value: key, label }))}
        />
      </div>
      {page?.stale && !list.failure ? (
        <StaleNotice fetchedAt={page.fetchedAt} busy={list.reloading} onRetry={list.reload} />
      ) : null}
      {list.failure ? (
        <CommunityFailureState failure={list.failure} busy={list.reloading} onRetry={list.reload} />
      ) : items === undefined ? (
        <CommunityLoading />
      ) : items.length === 0 ? (
        <EmptyState icon={<Store size={22} />} title={query.trim() ? '没有找到相关扩展' : '社区里还没有扩展'}>
          {query.trim() ? '换个关键词试试。' : '在扩展详情中选择「发布到社区」，就可以分享你的扩展。'}
        </EmptyState>
      ) : (
        <div className={styles.communityGrid}>
          {items.map((item) => (
            <Link
              key={item.id}
              to={`/community/extensions/${item.id}`}
              className={[styles.communityCard, spotlight.className].join(' ')}
              onPointerMove={spotlight.onPointerMove}
            >
              <span className={styles.communityCardHead}>
                <ExtensionIcon id={item.id} name={item.displayName} iconUrl={item.iconUrl} />
                <span className={styles.communityCardTitle}>
                  <b>{item.displayName}</b>
                  <span className={styles.faint}>{providesLabel(item.provides)}</span>
                </span>
              </span>
              <span className={styles.communitySummary}>{item.summary || '作者还没有填写介绍。'}</span>
              <span className={styles.communityCardFoot}>
                {item.official ? <Chip tone="accent">官方</Chip> : null}
                {installed.has(item.id) ? <InstalledChip updatable={updatable.has(item.id)} /> : null}
                <UpgradeChip requiresSdk={item.latest?.requiresSdk} />
                <ReviewChip status={item.latest} />
                <RatingMark rating={item.latest?.rating ?? null} />
                <span className={styles.faint}>
                  {publisherName(item.publisher)} · {relativeTime(item.updatedAt)}更新
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {page?.nextCursor && !list.failure ? (
        <div>
          <Button busy={loadingMore} onClick={() => void loadMore()}>
            加载更多
          </Button>
        </div>
      ) : null}
    </MainContent>
  )
}

function CommunityDetail({
  extensionId,
  onInspected,
}: {
  readonly extensionId: string
  readonly onInspected: (inspection: Inspection, detail: CommunityExtensionDetail) => void
}) {
  const [busy, setBusy] = useState(false)
  const installed = useProductStore((state) => state.extensions.some((item) => item.id === extensionId))
  const go = useGo()
  const read = useCommunityRead(
    (refresh) =>
      callHostApi(
        HostApiContracts.getCommunityExtension,
        { extensionId, ...(refresh ? { refresh: '1' as const } : {}) },
        undefined,
      ),
    [extensionId],
  )
  const detail = read.data

  const back = (
    <Link to="/community" className={styles.backLink}>
      <ArrowLeft size={14} />
      发现
    </Link>
  )
  if (read.failure) {
    return (
      <MainContent>
        {back}
        <CommunityFailureState failure={read.failure} busy={read.reloading} onRetry={read.reload} />
      </MainContent>
    )
  }
  if (!detail) {
    return (
      <MainContent>
        {back}
        <CommunityLoading height={160} />
      </MainContent>
    )
  }

  const latest = detail.latest
  // 源码地址留空时作者端会填入社区扩展页；与「在社区查看」重复时不再单独显示。
  const sourceUrl = detail.sourceUrl && detail.sourceUrl !== detail.pageUrl ? detail.sourceUrl : null
  const label = latest ? communityReviewLabel(latest.reviewStatus) : undefined
  const needs = neededVersion(latest?.requiresSdk)
  const needsUpgrade = needs !== undefined
  const install = async () => {
    if (!latest) return
    setBusy(true)
    try {
      onInspected(
        await callHostApi(HostApiContracts.importCommunityRelease, { releaseId: latest.id }, undefined),
        detail,
      )
    } catch (caught) {
      toast(message(caught), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <MainContent>
      {back}
      <ObjectHeader
        visual={<ExtensionIcon id={detail.id} name={detail.displayName} iconUrl={detail.iconUrl} size="lg" />}
        title={detail.displayName}
        status={label ? <Chip tone={label.tone}>{label.label}</Chip> : undefined}
        meta={
          <>
            <span>{providesLabel(detail.provides)}</span>
            <span>{publisherName(detail.publisher)}</span>
            {latest ? <span>{relativeTime(latest.createdAt)}发布</span> : null}
            <span>{detail.downloads} 次下载</span>
            {detail.branchOf ? (
              detail.branchOf.displayName ? (
                <Link to={`/community/extensions/${detail.branchOf.extensionId}`}>
                  分支自「{detail.branchOf.displayName}」
                </Link>
              ) : (
                <span>分支自一个未公开的扩展</span>
              )
            ) : null}
            {detail.branchCount ? <span>{detail.branchCount} 个分支</span> : null}
          </>
        }
        actions={
          <>
            <Button
              size="small"
              variant="ghost"
              icon={<ExternalLink size={14} />}
              onClick={() => openExternal(detail.pageUrl)}
            >
              在社区查看
            </Button>
            {latest ? (
              <Button size="small" variant="primary" busy={busy} disabled={needsUpgrade} onClick={() => void install()}>
                {installed ? '导入这次发布' : '安装'}
              </Button>
            ) : null}
          </>
        }
      />
      {detail.stale ? <StaleNotice fetchedAt={detail.fetchedAt} busy={read.reloading} onRetry={read.reload} /> : null}
      {detail.summary ? <p className={styles.lead}>{detail.summary}</p> : null}
      {detail.tags.length > 0 || sourceUrl ? (
        <div className={styles.listingMeta}>
          {detail.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
          {sourceUrl ? (
            <Button size="small" variant="ghost" icon={<Code2 size={14} />} onClick={() => openExternal(sourceUrl)}>
              源码
            </Button>
          ) : null}
        </div>
      ) : null}
      {detail.review ? <RatingCard review={detail.review} pageUrl={detail.pageUrl} /> : null}
      {label?.tone === 'neutral' ? (
        <Banner tone="warn">这次发布还没审查完，风险未知。只安装你信任的作者的扩展。</Banner>
      ) : null}
      {label?.tone === 'warn' ? <Banner tone="bad">审查发现了安全问题，安装前请先看审查记录。</Banner> : null}
      {needsUpgrade ? (
        <Banner
          tone="warn"
          action={
            <Button size="small" onClick={() => go('/settings/about')}>
              检查更新
            </Button>
          }
        >
          {needs ? `需要 NekroNXT ${needs} 或更高版本` : '需要更新版本的 NekroNXT'}
          {currentVersion ? `，当前为 ${currentVersion}` : ''}。
        </Banner>
      ) : installed ? (
        <Banner tone="info">本机已有这个扩展，这次会作为新版本导入，需要时在扩展详情里切换。</Banner>
      ) : null}

      <PropertyGroup title="介绍">
        {detail.description.trim() ? (
          <MarkdownDocument text={detail.description} />
        ) : (
          <p className={styles.faint}>作者还没有填写详细介绍。</p>
        )}
      </PropertyGroup>

      {latest && latest.permissions.length > 0 ? (
        Object.entries(PERMISSION_LAYERS).map(([layer, { title, description }]) => {
          const items = latest.permissions.filter((permission) => (permission.layer ?? 'agent') === layer)
          return items.length === 0 ? null : (
            <PropertyGroup key={layer} title={title} description={description}>
              <PropertyList>
                {items.map((permission, index) => (
                  <PropertyRow
                    key={`${permission.key}-${index}`}
                    label={permission.label}
                    description={permission.detail}
                  >
                    <Chip tone={LEVEL_TONE[permission.level]}>{LEVEL_LABEL[permission.level]}</Chip>
                  </PropertyRow>
                ))}
              </PropertyList>
            </PropertyGroup>
          )
        })
      ) : (
        <PropertyGroup title="需要的权限">
          <p className={styles.faint}>没有申请额外权限。</p>
        </PropertyGroup>
      )}

      {latest?.notes ? (
        <PropertyGroup title="更新说明" description={`${relativeTime(latest.createdAt)}发布`}>
          <p className={styles.communityDescription}>{latest.notes}</p>
        </PropertyGroup>
      ) : null}
    </MainContent>
  )
}
