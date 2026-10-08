import { communityPublisherLabel, HostApiContracts, type CommunityPersonaSummary } from '@nekro-nxt/contracts'
import { ArrowLeft, ExternalLink, UsersRound, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MarkdownDocument } from '../../components/markdown-document.js'
import { callHostApi } from '../../host-api-client.js'
import {
  Banner,
  Button,
  Chip,
  DetailPane,
  EmptyState,
  InfoTip,
  MainContent,
  ObjectHeader,
  ObjectTile,
  Pressable,
  PropertyGroup,
  SearchField,
  Skeleton,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { errorMessage, openExternal } from './community-model.js'
import { PersonaInstallDialog } from './persona-install-dialog.js'
import { usePersonaDetail } from './persona-model.js'
import styles from './personas.module.css'

const MAX_TAGS = 12

/** 人设头像：社区头像经本机代理读取；没有头像时显示名称首字。 */
const PERSONA_AVATAR_PX = { sm: 36, md: 44, lg: 64 } as const

/** 人设头像：与扩展图标同一套方形图块，无头像时用首字与由人设 ID 决定的配色。 */
export function PersonaAvatar({
  id,
  name,
  url,
  size = 'md',
}: {
  readonly id: string
  readonly name: string
  readonly url: string | null
  readonly size?: 'sm' | 'md' | 'lg'
}) {
  return <ObjectTile seed={id} name={name} imageUrl={url} pixels={PERSONA_AVATAR_PX[size]} fit="cover" />
}

/** 「社区 → 人设」：卡片网格，搜索与标签筛选。宽窗口下选中的卡片在右侧详情中打开，列表保持可见。 */
export function PersonaCatalog({ selectedId }: { readonly selectedId: string | undefined }) {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [items, setItems] = useState<readonly CommunityPersonaSummary[]>()
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)
  const [seenTags, setSeenTags] = useState<ReadonlyMap<string, number>>(new Map())

  const params = (next?: string) => ({
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(tag ? { tag } : {}),
    ...(next ? { cursor: next } : {}),
  })

  const remember = (list: readonly CommunityPersonaSummary[]) =>
    setSeenTags((current) => {
      const next = new Map(current)
      for (const item of list) for (const name of item.tags) next.set(name, (next.get(name) ?? 0) + 1)
      return next
    })

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setError(undefined)
      callHostApi(HostApiContracts.listCommunityPersonas, params(), undefined)
        .then((result) => {
          if (cancelled) return
          setItems(result.items)
          setCursor(result.nextCursor)
          if (!tag) remember(result.items)
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(errorMessage(caught))
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, tag])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const result = await callHostApi(HostApiContracts.listCommunityPersonas, params(cursor), undefined)
      setItems((current) => [...(current ?? []), ...result.items])
      setCursor(result.nextCursor)
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setLoadingMore(false)
    }
  }

  const tags = useMemo(() => {
    const ranked = [...seenTags.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
    const top = ranked.slice(0, MAX_TAGS)
    return tag && !top.includes(tag) ? [tag, ...top] : top
  }, [seenTags, tag])

  return (
    <MainContent>
      <ObjectHeader
        visual={
          <span className={styles.glyph}>
            <UsersRound size={18} />
          </span>
        }
        title="人设"
        meta={
          <span className={styles.metaWithTip}>
            社区作者分享的智能体人设
            <InfoTip label="人设">
              人设只包含名称、头像和设定，不含模型与扩展。可以安装成新的智能体，也可以替换现有智能体的设定，原来的设定能在智能体的「恢复之前的配置」中找回。
            </InfoTip>
          </span>
        }
      />
      <div className={styles.tools}>
        <SearchField value={query} onChange={setQuery} label="搜索社区人设" placeholder="搜索名称、简介或标签" />
        {tags.length > 0 ? (
          <div className={styles.tagBar} role="group" aria-label="按标签筛选">
            {tags.map((name) => (
              <Pressable
                key={name}
                className={styles.tagFilter}
                aria-pressed={tag === name}
                onClick={() => setTag((current) => (current === name ? '' : name))}
              >
                {name}
                {tag === name ? <X size={12} aria-hidden="true" /> : null}
              </Pressable>
            ))}
          </div>
        ) : null}
      </div>
      {error ? (
        <Banner tone="bad">{error}</Banner>
      ) : items === undefined ? (
        <Skeleton height={120} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UsersRound size={22} />}
          title={query.trim() || tag ? '没有找到相关人设' : '社区里还没有人设'}
        >
          {query.trim() || tag ? '换个关键词或标签试试。' : '在智能体页的「更多 → 分享人设到社区」可以分享你的人设。'}
        </EmptyState>
      ) : (
        <div className={styles.grid}>
          {items.map((item, index) => (
            <Link
              key={item.id}
              to={selectedId === item.id ? '/community/personas' : `/community/personas/${item.id}`}
              className={styles.card}
              data-selected={selectedId === item.id}
              aria-current={selectedId === item.id ? 'true' : undefined}
              style={{ ['--i' as string]: Math.min(index, 12) }}
            >
              <span className={styles.cardHead}>
                <PersonaAvatar id={item.id} name={item.name} url={item.avatarUrl} />
                <span className={styles.cardTitle}>
                  <b>{item.name}</b>
                  <span className={styles.faint}>
                    {item.official ? '官方' : communityPublisherLabel(item.publisher.handle)}
                  </span>
                </span>
              </span>
              <span className={styles.cardSummary}>{item.summary || '作者还没有填写简介。'}</span>
              <span className={styles.cardFoot}>
                {item.tags.slice(0, 3).map((name) => (
                  <span key={name} className={styles.tag}>
                    {name}
                  </span>
                ))}
                <span className={styles.installs}>{item.installs} 次安装</span>
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

/**
 * 一个人设的详情：作者介绍在前，人设正文可展开，审查只轻量标注。`pane` 用于宽窗口右侧详情，`page` 用于窄窗口
 * 与深链直接进入。
 */
export function PersonaDetail({
  personaId,
  mode,
  onClose,
}: {
  readonly personaId: string
  readonly mode: 'pane' | 'page'
  readonly onClose?: () => void
}) {
  const { detail, error } = usePersonaDetail(personaId)
  const [expanded, setExpanded] = useState(false)
  const [installing, setInstalling] = useState(false)

  const actions = detail ? (
    <>
      <Button
        size="small"
        variant="ghost"
        icon={<ExternalLink size={14} />}
        onClick={() => openExternal(detail.pageUrl)}
      >
        在社区查看
      </Button>
      <Button size="small" variant="primary" onClick={() => setInstalling(true)}>
        安装
      </Button>
    </>
  ) : null

  const header = detail ? (
    <ObjectHeader
      size={mode === 'pane' ? 'compact' : 'default'}
      visual={
        <PersonaAvatar id={detail.id} name={detail.name} url={detail.avatarUrl} size={mode === 'pane' ? 'md' : 'lg'} />
      }
      title={detail.name}
      status={detail.official ? <Chip tone="accent">官方</Chip> : undefined}
      meta={
        <>
          <span>{communityPublisherLabel(detail.publisher.handle)}</span>
          <span>{detail.installs} 次安装</span>
          <span>{relativeTime(detail.revision.createdAt)}更新</span>
        </>
      }
    />
  ) : (
    <ObjectHeader size="compact" title={error ? '无法读取人设' : '正在读取…'} />
  )

  const body = error ? (
    <Banner tone="bad">{error}</Banner>
  ) : !detail ? (
    <Skeleton height={160} />
  ) : (
    <div className={styles.detail}>
      {detail.summary ? <p className={styles.lead}>{detail.summary}</p> : null}
      {detail.tags.length > 0 ? (
        <div className={styles.tagRow}>
          {detail.tags.map((name) => (
            <span key={name} className={styles.tag}>
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {detail.description ? (
        <PropertyGroup title="介绍">
          <MarkdownDocument text={detail.description} />
        </PropertyGroup>
      ) : null}
      <PropertyGroup
        title="人设正文"
        actions={
          detail.persona.length > 240 || detail.persona.split('\n').length > 6 ? (
            <Pressable className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : '展开全文'}
            </Pressable>
          ) : undefined
        }
      >
        <div className={styles.personaBox}>
          <p className={styles.personaText} data-expanded={expanded}>
            {detail.persona || '（空）'}
          </p>
        </div>
      </PropertyGroup>
      {detail.revision.notes ? (
        <PropertyGroup title="更新说明">
          <p className={styles.notes}>{detail.revision.notes}</p>
        </PropertyGroup>
      ) : null}
      <p className={styles.review}>
        {detail.review?.status === 'flagged' ? (
          <Chip tone="warn">内容待复核</Chip>
        ) : detail.review?.status === 'approved' ? (
          <Chip tone="ok">内容审查通过</Chip>
        ) : (
          <Chip>尚未审查</Chip>
        )}
        {detail.review?.summary ? <InfoTip label="审查结论">{detail.review.summary}</InfoTip> : null}
      </p>
    </div>
  )

  const dialog = detail ? (
    <PersonaInstallDialog persona={detail} open={installing} onOpenChange={setInstalling} />
  ) : null

  if (mode === 'pane') {
    return (
      <DetailPane
        label="人设详情"
        header={header}
        {...(onClose ? { onClose } : {})}
        footer={detail ? <div className={styles.paneActions}>{actions}</div> : undefined}
      >
        {body}
        {dialog}
      </DetailPane>
    )
  }
  return (
    <MainContent width="readable">
      <Link to="/community/personas" className={styles.backLink}>
        <ArrowLeft size={14} />
        人设
      </Link>
      {header}
      {detail ? <div className={styles.pageActions}>{actions}</div> : null}
      {body}
      {dialog}
    </MainContent>
  )
}
