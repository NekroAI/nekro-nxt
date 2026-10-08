import {
  communityPublisherLabel,
  communityReviewLabel,
  HostApiContracts,
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
  Disclosure,
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
import { openExternal } from './community-model.js'
import { scopeLabel } from '../workshop/workshop-model.js'
import styles from './community.module.css'

type Inspection = HostApiResponse<'inspectExtensionImport'>
type Scope = '' | 'agent' | 'host-ui' | 'host-adapter'

const SCOPES: readonly { readonly value: Scope; readonly label: string }[] = [
  { value: '', label: '全部' },
  { value: 'agent', label: '智能体扩展' },
  { value: 'host-ui', label: '页面' },
  { value: 'host-adapter', label: '平台适配器' },
]

const LEVEL_LABEL = { normal: '常规', elevated: '需留意', high: '高风险' } as const
const LEVEL_TONE = { normal: 'neutral', elevated: 'warn', high: 'bad' } as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ReviewChip = ({ status }: { readonly status: CommunityExtensionSummary['latest'] }) => {
  if (!status) return null
  const label = communityReviewLabel(status.reviewStatus)
  return <Chip tone={label.tone}>{label.label}</Chip>
}

const severityOf = (severity: string): { readonly tone: 'bad' | 'warn'; readonly label: string } =>
  severity === 'critical'
    ? { tone: 'bad', label: '严重' }
    : severity === 'risk'
      ? { tone: 'bad', label: '风险' }
      : { tone: 'warn', label: '提醒' }

/**
 * 审查只做轻量呈现：一行状态与摘要，点开再看全部审查发现。审查结论只描述发现，不代表扩展绝对安全。
 */
function ReviewSummary({
  review,
  pageUrl,
}: {
  readonly review: NonNullable<CommunityExtensionDetail['review']>
  readonly pageUrl: string
}) {
  const [open, setOpen] = useState(false)
  const label = communityReviewLabel(review.status)
  const hasDetail = Boolean(review.summary) || review.highlights.length > 0
  return (
    <section className={styles.reviewLine} aria-label="审查">
      <div className={styles.reviewLineHead}>
        <Chip tone={label.tone}>{label.label}</Chip>
        {review.grade ? <Chip>质量 {review.grade}</Chip> : null}
        <span className={styles.reviewLineSummary}>
          {review.summary || (review.highlights.length > 0 ? `${review.highlights.length} 条审查发现` : '暂无审查摘要')}
        </span>
        {hasDetail ? (
          <Button
            size="small"
            variant="ghost"
            aria-expanded={open}
            aria-controls="community-review-detail"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : '审查详情'}
          </Button>
        ) : null}
      </div>
      <Disclosure open={open} id="community-review-detail">
        <div className={styles.communityReview}>
          {review.summary ? <p>{review.summary}</p> : null}
          {review.highlights.map((item, index) => {
            const severity = severityOf(item.severity)
            return (
              <p key={index} className={styles.communityHighlight}>
                <Chip tone={severity.tone}>{severity.label}</Chip>
                {item.title}
              </p>
            )
          })}
          <p className={styles.faint}>审查结论只描述审查发现，不代表扩展绝对安全。</p>
          <div>
            <Button
              size="small"
              variant="ghost"
              icon={<ExternalLink size={14} />}
              onClick={() => openExternal(pageUrl)}
            >
              在社区查看完整报告
            </Button>
          </div>
        </div>
      </Disclosure>
    </section>
  )
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
  const [scope, setScope] = useState<Scope>('')
  const [officialOnly, setOfficialOnly] = useState(false)
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
          ...(scope ? { scope } : {}),
          ...(officialOnly ? { official: '1' as const } : {}),
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
  }, [query, scope, officialOnly])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const result = await callHostApi(
        HostApiContracts.listCommunityExtensions,
        {
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(scope ? { scope } : {}),
          ...(officialOnly ? { official: '1' as const } : {}),
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
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph}>
            <Store size={18} />
          </span>
        }
        title="发现"
        meta={<span>扩展由社区作者提供，每次发布都会经过自动审查；安装后不会自动启用</span>}
      />
      <div className={styles.communityTools}>
        <SearchField value={query} onChange={setQuery} label="搜索社区扩展" placeholder="搜索名称、介绍或标签" />
        <Segmented<Scope> label="扩展类型" value={scope} onChange={setScope} options={SCOPES} />
        <label className={styles.inlineSwitch} htmlFor="community-official-only">
          <Switch
            id="community-official-only"
            checked={officialOnly}
            onCheckedChange={setOfficialOnly}
            label="只看官方扩展"
          />
          只看官方
        </label>
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
                  <span className={styles.faint}>{scopeLabel[item.scope]}</span>
                </span>
              </span>
              <span className={styles.communitySummary}>{item.summary || '作者还没有填写介绍。'}</span>
              <span className={styles.communityCardFoot}>
                {item.official ? <Chip tone="accent">官方</Chip> : null}
                <ReviewChip status={item.latest} />
                {item.latest?.grade ? <Chip>质量 {item.latest.grade}</Chip> : null}
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
            <span>{scopeLabel[detail.scope]}</span>
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
              <Button size="small" variant="primary" busy={busy} onClick={() => void install()}>
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
      {label?.tone === 'neutral' ? (
        <Banner tone="warn">
          这次发布还没有完成审查，风险未知。扩展会以 NekroNXT 的权限运行，请只安装你信任的作者的扩展。
        </Banner>
      ) : null}
      {label?.tone === 'warn' ? (
        <Banner tone="bad">审查发现了可能被利用或伤害你的问题。请阅读审查发现，理解风险后再安装。</Banner>
      ) : null}
      {installed ? (
        <Banner tone="info">本机已有这个扩展。导入新的发布会成为它的一条保存记录，不会自动切换使用。</Banner>
      ) : null}

      <PropertyGroup title="介绍">
        {detail.description.trim() ? (
          <MarkdownDocument text={detail.description} />
        ) : (
          <p className={styles.faint}>作者还没有填写详细介绍。</p>
        )}
      </PropertyGroup>

      {detail.review ? <ReviewSummary review={detail.review} pageUrl={detail.pageUrl} /> : null}

      <PropertyGroup title="需要的权限" description="启用时还会再次请你确认。">
        {latest && latest.permissions.length > 0 ? (
          <PropertyList>
            {latest.permissions.map((permission, index) => (
              <PropertyRow key={`${permission.key}-${index}`} label={permission.label} description={permission.detail}>
                <Chip tone={LEVEL_TONE[permission.level]}>{LEVEL_LABEL[permission.level]}</Chip>
              </PropertyRow>
            ))}
          </PropertyList>
        ) : (
          <p className={styles.faint}>没有申请额外权限。</p>
        )}
      </PropertyGroup>

      {latest?.notes ? (
        <PropertyGroup title="更新说明" description={`${relativeTime(latest.createdAt)}发布`}>
          <p className={styles.communityDescription}>{latest.notes}</p>
        </PropertyGroup>
      ) : null}
    </MainContent>
  )
}
