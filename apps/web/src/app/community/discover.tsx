import {
  COMMUNITY_EXTENSION_SORTS,
  communityPublisherLabel,
  communityReviewLabel,
  EXTENSION_SDK_LEVEL,
  HostApiContracts,
  type CommunityExtensionSort,
  type CommunityExtensionDetail,
  type CommunityExtensionSummary,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { ArrowLeft, Code2, ExternalLink, Store } from 'lucide-react'
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
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SearchField,
  Segmented,
  Switch,
  Skeleton,
  toast,
} from '../../ui-kit/index.js'
import { MarkdownDocument } from '../../components/markdown-document.js'
import { relativeTime } from '../channels/timeline-model.js'
import { RatingCard, RatingMark } from './community-rating.js'
import { openExternal } from './community-model.js'
import { providesLabel } from '../workshop/workshop-model.js'
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

const ReviewChip = ({ status }: { readonly status: CommunityExtensionSummary['latest'] }) => {
  if (!status) return null
  const label = communityReviewLabel(status.reviewStatus)
  return <Chip tone={label.tone}>{label.label}</Chip>
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

function CommunityCatalog() {
  const [query, setQuery] = useState('')
  const [provides, setProvides] = useState<Provides>('')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [sort, setSort] = useState<CommunityExtensionSort>('updated')
  const [items, setItems] = useState<readonly CommunityExtensionSummary[]>()
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setError(undefined)
      callHostApi(
        HostApiContracts.listCommunityExtensions,
        {
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(provides ? { provides } : {}),
          ...(officialOnly ? { official: '1' as const } : {}),
          ...(sort === 'updated' ? {} : { sort }),
        },
        undefined,
      )
        .then((result) => {
          if (cancelled) return
          setItems(result.items)
          setCursor(result.nextCursor)
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(message(caught))
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, provides, officialOnly, sort])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const result = await callHostApi(
        HostApiContracts.listCommunityExtensions,
        {
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(provides ? { provides } : {}),
          ...(officialOnly ? { official: '1' as const } : {}),
          ...(sort === 'updated' ? {} : { sort }),
          cursor,
        },
        undefined,
      )
      setItems((current) => [...(current ?? []), ...result.items])
      setCursor(result.nextCursor)
    } catch (caught) {
      toast(message(caught), { tone: 'bad' })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <MainContent width="full">
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph}>
            <Store size={18} />
          </span>
        }
        title="发现"
        meta={<span>由社区作者发布，均经过自动审查</span>}
      />
      <div className={styles.communityTools}>
        <SearchField value={query} onChange={setQuery} label="搜索社区扩展" placeholder="搜索名称、介绍或标签" />
        <Segmented<Provides> label="提供什么" value={provides} onChange={setProvides} options={PROVIDES} />
        <label className={styles.inlineSwitch} htmlFor="community-official-only">
          <Switch
            id="community-official-only"
            checked={officialOnly}
            onCheckedChange={setOfficialOnly}
            label="只看官方扩展"
          />
          只看官方
        </label>
        <Segmented<CommunityExtensionSort>
          label="排序"
          value={sort}
          onChange={setSort}
          options={COMMUNITY_EXTENSION_SORTS.map(({ key, label }) => ({ value: key, label }))}
        />
      </div>
      {error ? (
        <Banner tone="bad">{error}</Banner>
      ) : items === undefined ? (
        <Skeleton height={96} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Store size={22} />} title={query.trim() ? '没有找到相关扩展' : '社区里还没有扩展'}>
          {query.trim() ? '换个关键词试试。' : '在扩展详情中选择「发布到社区」，就可以分享你的扩展。'}
        </EmptyState>
      ) : (
        <div className={styles.communityGrid}>
          {items.map((item) => (
            <Link key={item.id} to={`/community/extensions/${item.id}`} className={styles.communityCard}>
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
                <ReviewChip status={item.latest} />
                <RatingMark rating={item.latest?.rating ?? null} />
                <span className={styles.faint}>
                  {communityPublisherLabel(item.publisher.handle)} · {relativeTime(item.updatedAt)}更新
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {cursor ? (
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
  const [detail, setDetail] = useState<CommunityExtensionDetail>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const installed = useProductStore((state) => state.extensions.some((item) => item.id === extensionId))

  useEffect(() => {
    let cancelled = false
    callHostApi(HostApiContracts.getCommunityExtension, { extensionId }, undefined)
      .then((result) => {
        if (!cancelled) setDetail(result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(message(caught))
      })
    return () => {
      cancelled = true
    }
  }, [extensionId])

  const back = (
    <Link to="/community" className={styles.backLink}>
      <ArrowLeft size={14} />
      发现
    </Link>
  )
  if (error) {
    return (
      <MainContent>
        {back}
        <Banner tone="bad">{error}</Banner>
      </MainContent>
    )
  }
  if (!detail) {
    return (
      <MainContent>
        {back}
        <Skeleton height={160} />
      </MainContent>
    )
  }

  const latest = detail.latest
  // 源码地址留空时作者端会填入社区扩展页；与「在社区查看」重复时不再单独显示。
  const sourceUrl = detail.sourceUrl && detail.sourceUrl !== detail.pageUrl ? detail.sourceUrl : null
  const label = latest ? communityReviewLabel(latest.reviewStatus) : undefined
  const needsUpgrade = latest?.requiresSdk != null && latest.requiresSdk > EXTENSION_SDK_LEVEL
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
            <span>{communityPublisherLabel(detail.publisher.handle)}</span>
            {latest ? <span>{relativeTime(latest.createdAt)}发布</span> : null}
            <span>{detail.downloads} 次下载</span>
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
        <Banner tone="warn">这个扩展需要更新版本的 NekroNXT，请先升级后再安装。</Banner>
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
