import {
  COMMUNITY_REVIEW_DIMENSION_LABELS,
  communityReviewLabel,
  HostApiContracts,
  type CommunityMyExtension,
  type CommunityReviewReport,
} from '@nekro-nxt/contracts'
import { ArrowLeft, ExternalLink, RefreshCw, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ExtensionIcon,
  MainContent,
  ObjectHeader,
  PropertyGroup,
  Skeleton,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { PublishDialog } from '../workshop/publish-dialog.js'
import { providesLabel } from '../workshop/workshop-model.js'
import { errorMessage, openExternal, type CommunityState } from './community-model.js'
import { MyPersonasSection } from './my-personas.js'
import { BadgeChips, RatingHexagon, RatingMark, Stars } from './community-rating.js'
import styles from './community.module.css'

type Release = CommunityMyExtension['releases'][number]

const usableRevision = (extension: LocalExtensionSummary) =>
  extension.revisions.findLast((revision) => revision.format === undefined || revision.format === 'current')

/** 我在社区的扩展与每次发布的审查状态；本机尚未发布的扩展可以直接发布。 */
export function MineView({ community }: { readonly community: CommunityState }) {
  const account = community.status?.account ?? null
  const localExtensions = useProductStore((state) => state.extensions)
  const [items, setItems] = useState<readonly CommunityMyExtension[]>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [withdrawing, setWithdrawing] = useState<{ extension: CommunityMyExtension; release: Release }>()
  const [publishing, setPublishing] = useState<LocalExtensionSummary>()

  const load = async () => {
    setLoading(true)
    try {
      setItems((await callHostApi(HostApiContracts.listCommunityMine, {}, undefined)).items)
      setError(undefined)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (account) void load()
  }, [account?.handle])

  if (community.status && !account) {
    return (
      <MainContent>
        <EmptyState
          icon={<Send size={22} />}
          title="登录社区后查看你的发布"
          action={
            <Button
              size="small"
              variant="primary"
              onClick={() => void community.signIn().catch((caught) => toast(errorMessage(caught), { tone: 'bad' }))}
            >
              登录社区
            </Button>
          }
        >
          登录后可以把扩展发布到社区，并在这里查看每次发布的审查结果与建议。
        </EmptyState>
      </MainContent>
    )
  }

  const published = new Set<string>(items?.map((item) => item.id))
  const localPublishable = new Map(
    localExtensions.filter((extension) => usableRevision(extension)).map((extension) => [extension.id, extension]),
  )
  // 社区返回的图标优先；旧版社区没有图标时用本机同一扩展的图标。
  const communityIcon = (extension: CommunityMyExtension) =>
    extension.iconUrl ?? localPublishable.get(extension.id)?.iconUrl
  const unpublished = localExtensions.filter((extension) => !published.has(extension.id) && usableRevision(extension))

  const requestReview = async (release: Release) => {
    try {
      await callHostApi(HostApiContracts.requestCommunityReview, { releaseId: release.id }, undefined)
      toast('已重新提交审查')
      await load()
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    }
  }

  return (
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.objectGlyph}>
            <Send size={20} />
          </span>
        }
        title="我的发布"
        meta={<span>{account ? `@${account.handle}` : ''}</span>}
        actions={
          <Button size="small" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
      />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {items === undefined && !error ? (
        <Skeleton height={140} />
      ) : items && items.length === 0 ? (
        <p className={styles.faint}>还没有发布过扩展。在工坊打开自己的扩展，就能发布到社区。</p>
      ) : (
        <div className={styles.cardList}>
          {items?.map((extension, index) => (
            <article key={extension.id} className={styles.item} style={{ ['--i' as string]: index }}>
              <ExtensionIcon
                id={extension.id}
                name={extension.displayName}
                iconUrl={communityIcon(extension)}
                size="lg"
              />
              <div className={styles.itemBody}>
                <div className={styles.itemTitle}>
                  {extension.displayName}
                  {extension.delisted ? <Chip tone="bad">已下架</Chip> : null}
                </div>
                <span className={styles.itemMeta}>
                  {providesLabel(extension.provides)} · {extension.downloads} 次下载 ·{' '}
                  {relativeTime(extension.updatedAt)}更新
                </span>
                {extension.delisted && extension.delistedReason ? (
                  <span className={styles.itemMeta}>下架原因：{extension.delistedReason}</span>
                ) : null}
                <ul className={styles.releases}>
                  {extension.releases.map((release) => {
                    const label = communityReviewLabel(release.reviewStatus)
                    return (
                      <li key={release.id} className={styles.release}>
                        <span>{relativeTime(release.createdAt)}发布</span>
                        <Chip tone={label.tone}>{label.label}</Chip>
                        <RatingMark rating={release.rating} />
                        {release.withdrawn ? <Chip>已撤回</Chip> : null}
                        <Link to={`/community/mine/releases/${release.id}`} className={styles.textLink}>
                          审查报告
                        </Link>
                        {!release.withdrawn && ['incomplete', 'flagged'].includes(release.reviewStatus) ? (
                          <Button size="small" variant="ghost" onClick={() => void requestReview(release)}>
                            重新审查
                          </Button>
                        ) : null}
                        {!release.withdrawn ? (
                          <Button size="small" variant="ghost" onClick={() => setWithdrawing({ extension, release })}>
                            撤回
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
              <div className={styles.itemActions}>
                <Button
                  size="small"
                  variant="ghost"
                  icon={<ExternalLink size={14} />}
                  onClick={() => openExternal(extension.pageUrl)}
                >
                  社区页面
                </Button>
                {localPublishable.get(extension.id) ? (
                  <Button size="small" onClick={() => setPublishing(localPublishable.get(extension.id))}>
                    发布更新
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {account ? <MyPersonasSection refreshKey={items} /> : null}

      {unpublished.length > 0 ? (
        <PropertyGroup title="本机尚未发布的扩展" description="发布最新版本，社区会自动审查源码和权限。">
          <div className={styles.cardList}>
            {unpublished.map((extension) => (
              <div key={extension.id} className={styles.item}>
                <ExtensionIcon id={extension.id} name={extension.name} iconUrl={extension.iconUrl} size="lg" />
                <div className={styles.itemBody}>
                  <div className={styles.itemTitle}>{extension.name}</div>
                  <span className={styles.itemMeta}>{providesLabel(extension.provides)}</span>
                </div>
                <div className={styles.itemActions}>
                  <Button size="small" onClick={() => setPublishing(extension)}>
                    发布
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </PropertyGroup>
      ) : null}

      {publishing ? (
        <PublishDialog
          extension={publishing}
          revision={usableRevision(publishing)}
          open
          onOpenChange={(open) => {
            if (!open) {
              setPublishing(undefined)
              void load()
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={withdrawing !== undefined}
        onOpenChange={(open) => !open && setWithdrawing(undefined)}
        title={`撤回「${withdrawing?.extension.displayName ?? ''}」的这次发布？`}
        confirmLabel="撤回"
        danger
        onConfirm={async () => {
          const target = withdrawing
          setWithdrawing(undefined)
          if (!target) return
          try {
            await callHostApi(HostApiContracts.withdrawCommunityRelease, { releaseId: target.release.id }, undefined)
            toast('已撤回')
            await load()
          } catch (caught) {
            toast(errorMessage(caught), { tone: 'bad' })
          }
        }}
      >
        <p>撤回后社区不再提供这次发布，已安装的用户会看到「作者已撤回」。</p>
      </ConfirmDialog>
    </MainContent>
  )
}

const DETERMINISTIC = {
  block: { tone: 'bad', label: '违规' },
  risk: { tone: 'warn', label: '风险' },
  warning: { tone: 'warn', label: '提醒' },
  info: { tone: 'neutral', label: '信息' },
} as const
const AI_SEVERITY = {
  critical: { tone: 'bad', label: '严重' },
  risk: { tone: 'warn', label: '风险' },
  warning: { tone: 'warn', label: '提醒' },
  suggestion: { tone: 'accent', label: '建议' },
  info: { tone: 'neutral', label: '信息' },
} as const

const location = (file?: string, line?: number) =>
  file ? (
    <span className={styles.location}>
      {file.replace(/^revision\//u, '')}
      {line ? `:${line}` : ''}
    </span>
  ) : null

/** 一次发布的完整审查报告：总结、质量维度、逐条建议、自动检查与人工复审。 */
export function ReviewReportView({ releaseId }: { readonly releaseId: string }) {
  const [report, setReport] = useState<CommunityReviewReport>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    callHostApi(HostApiContracts.getCommunityReleaseReview, { releaseId }, undefined)
      .then(setReport)
      .catch((caught: unknown) => setError(errorMessage(caught)))
  }, [releaseId])

  const back = (
    <Link to="/community/mine" className={styles.backLink}>
      <ArrowLeft size={14} />
      我的发布
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
  if (!report) {
    return (
      <MainContent>
        {back}
        <Skeleton height={200} />
      </MainContent>
    )
  }
  const label = communityReviewLabel(report.status)
  return (
    <MainContent>
      {back}
      <ObjectHeader
        title="审查报告"
        status={<Chip tone={label.tone}>{label.label}</Chip>}
        meta={
          <>
            {report.rating ? <span>综合评分 {report.rating.score.toFixed(1)}</span> : null}
            {report.finishedAt ? <span>{relativeTime(report.finishedAt)}完成</span> : <span>审查进行中或未完成</span>}
            {report.model ? <span>{report.model}</span> : null}
          </>
        }
        actions={
          <Button
            size="small"
            variant="ghost"
            icon={<ExternalLink size={14} />}
            onClick={() => openExternal(report.reportUrl)}
          >
            在社区查看
          </Button>
        }
      />
      {report.error && !report.ai ? <Banner tone="warn">AI 审查未完成：{report.error}</Banner> : null}
      {report.decisions.map((decision, index) => (
        <Banner key={index} tone={decision.decision === 'reject' ? 'bad' : 'info'}>
          @{decision.by} 人工复审：
          {decision.decision === 'approve' ? '通过' : decision.decision === 'reject' ? '驳回' : '确认有风险'}
          {decision.note ? ` —— ${decision.note}` : ''}
        </Banner>
      ))}
      {report.ai ? (
        <>
          {report.rating ? (
            <PropertyGroup
              title="评级"
              description="达成的标准显示在扩展页面上（最多 4 个）；六个维度都拿满 5 星时，六边形描金边。"
            >
              <div className={styles.ratingTop}>
                <div className={styles.ratingScore}>
                  <RatingHexagon rating={report.rating} size={160} />
                  <div>
                    <b>{report.rating.score.toFixed(1)}</b>
                    <span>综合评分</span>
                  </div>
                </div>
                <BadgeChips badges={report.rating.badges} limit={report.rating.badges.length} />
              </div>
            </PropertyGroup>
          ) : null}
          <PropertyGroup title="总评">
            <p className={styles.lead}>{report.ai.summary}</p>
            {report.ai.exploitability ? <Banner tone="bad">可被利用的方式：{report.ai.exploitability}</Banner> : null}
          </PropertyGroup>
          <PropertyGroup title="各维度">
            <div className={styles.dimensions}>
              {report.ai.dimensions.map((dimension) => {
                const rated = report.rating?.dimensions.find(({ key }) => key === dimension.key)
                const stars = rated?.stars ?? dimension.stars
                return (
                  <div key={dimension.key} className={styles.dimension}>
                    <span className={styles.dimensionHead}>
                      {COMMUNITY_REVIEW_DIMENSION_LABELS[dimension.key] ?? dimension.key}
                      <Stars stars={stars} />
                    </span>
                    <b>{dimension.headline}</b>
                    <span className={styles.faint}>{dimension.notes}</span>
                    {rated?.cap ? <span className={styles.reviewCap}>{rated.cap}</span> : null}
                    {stars < 5 && dimension.nextStar ? (
                      <p className={styles.suggestion}>
                        拿下第 {stars + 1} 颗星：{dimension.nextStar}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {report.ai.compliance && !report.ai.compliance.ok ? (
              <Banner tone="warn">合规：{report.ai.compliance.notes}</Banner>
            ) : null}
          </PropertyGroup>
          <PropertyGroup title={`审查建议（${report.ai.findings.length}）`}>
            {report.ai.findings.length === 0 ? (
              <p className={styles.faint}>没有需要修改的地方。</p>
            ) : (
              <div>
                {report.ai.findings.map((finding, index) => (
                  <div key={index} className={styles.finding}>
                    <span className={styles.inline}>
                      <Chip tone={AI_SEVERITY[finding.severity].tone}>{AI_SEVERITY[finding.severity].label}</Chip>
                      <b>{finding.title}</b>
                      <span className={styles.faint}>
                        {COMMUNITY_REVIEW_DIMENSION_LABELS[finding.dimension] ?? finding.dimension}
                      </span>
                      {location(finding.file, finding.line)}
                    </span>
                    <span>{finding.detail}</span>
                    {finding.suggestion ? <p className={styles.suggestion}>建议：{finding.suggestion}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </PropertyGroup>
        </>
      ) : null}
      <PropertyGroup title={`自动检查（${report.deterministic.length}）`}>
        {report.deterministic.length === 0 ? (
          <p className={styles.faint}>自动检查没有发现问题。</p>
        ) : (
          <div>
            {report.deterministic.map((finding, index) => (
              <div key={index} className={styles.finding}>
                <span className={styles.inline}>
                  <Chip tone={DETERMINISTIC[finding.severity].tone}>{DETERMINISTIC[finding.severity].label}</Chip>
                  <b>{finding.title}</b>
                  {location(finding.file, finding.line)}
                </span>
                <span className={styles.faint}>{finding.detail}</span>
              </div>
            ))}
          </div>
        )}
      </PropertyGroup>
    </MainContent>
  )
}
