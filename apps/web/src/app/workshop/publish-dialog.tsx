import {
  COMMUNITY_LISTING_LIMITS,
  communityReviewLabel,
  HostApiContracts,
  type CommunityListingInput,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import type { LocalExtensionSummary } from '../../product-runtime.js'
import { Banner, Button, Chip, Dialog, Field, Input, Textarea, toast } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { openExternal, useCommunityStatus } from '../community/community-model.js'

type Revision = LocalExtensionSummary['revisions'][number]
type Published = HostApiResponse<'publishToCommunity'>

interface ListingDraft {
  readonly summary: string
  readonly description: string
  readonly tags: string
  readonly sourceUrl: string
}

const EMPTY_LISTING: ListingDraft = { summary: '', description: '', tags: '', sourceUrl: '' }

/** 标签用逗号、顿号或空白分隔；去重后最多保留上限个数。 */
export const parseListingTags = (value: string): string[] => [
  ...new Set(
    value
      .split(/[,，、\s]+/u)
      .map((tag) => tag.trim().replace(/^#/u, ''))
      .filter(Boolean),
  ),
]

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** 扩展在社区上的页面；源码地址不能为空，留空时用它。 */
export const communityExtensionPage = (communityUrl: string, extensionId: string): string =>
  new URL(`/extensions/${encodeURIComponent(extensionId)}`, communityUrl).toString()

/**
 * 只提交和社区现有内容不同的条目信息；首次发布只提交填写了的字段。源码地址不能为空：留空时重置为扩展在社区上的
 * 页面（`defaultSourceUrl`）。
 */
export const listingChanges = (
  draft: ListingDraft,
  initial: ListingDraft,
  defaultSourceUrl?: string,
): CommunityListingInput => {
  const changed = (key: keyof ListingDraft) => draft[key].trim() !== initial[key].trim()
  const tags = parseListingTags(draft.tags)
  const sourceUrl = draft.sourceUrl.trim() || defaultSourceUrl || ''
  return {
    ...(changed('summary') ? { summary: draft.summary.trim() } : {}),
    ...(changed('description') ? { description: draft.description.trim() } : {}),
    ...(changed('tags') ? { tags } : {}),
    ...(sourceUrl && sourceUrl !== initial.sourceUrl.trim() ? { sourceUrl } : {}),
  }
}

const listingErrors = (draft: ListingDraft): { readonly tags?: string; readonly sourceUrl?: string } => {
  const tags = parseListingTags(draft.tags)
  const tagError =
    tags.length > COMMUNITY_LISTING_LIMITS.tags
      ? `标签最多 ${COMMUNITY_LISTING_LIMITS.tags} 个。`
      : tags.some((tag) => tag.length > COMMUNITY_LISTING_LIMITS.tag)
        ? `每个标签不超过 ${COMMUNITY_LISTING_LIMITS.tag} 字。`
        : undefined
  const urlError =
    draft.sourceUrl.trim() && !isHttpUrl(draft.sourceUrl.trim()) ? '源码地址需要是 http(s) 链接。' : undefined
  return { ...(tagError ? { tags: tagError } : {}), ...(urlError ? { sourceUrl: urlError } : {}) }
}

/**
 * 把一次保存发布到社区。发布内容就是导出的扩展包；社区会自动审查，审查完成前公开标注「风险未知」，
 * 发现泄露凭据等明确问题时不公开。
 */
export function PublishDialog({
  extension,
  revision,
  open,
  onOpenChange,
}: {
  readonly extension: LocalExtensionSummary
  readonly revision: Revision | undefined
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const community = useCommunityStatus(open)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState<Published>()
  const [listing, setListing] = useState<ListingDraft>(EMPTY_LISTING)
  const [initialListing, setInitialListing] = useState<ListingDraft>(EMPTY_LISTING)
  const [listingLoaded, setListingLoaded] = useState(false)
  useEffect(() => {
    if (open) setPublished(undefined)
  }, [open])
  const account = community.status?.account ?? null

  // 已发布过的扩展带出社区上的条目信息，供作者修改；首次发布用本机描述作为一句话简介的起点。
  useEffect(() => {
    if (!open || !account) return
    let cancelled = false
    setListingLoaded(false)
    callHostApi(HostApiContracts.getCommunityExtension, { extensionId: extension.id }, undefined)
      .then((detail) => {
        if (cancelled) return
        const current = {
          summary: detail.summary,
          description: detail.description,
          tags: detail.tags.join('、'),
          sourceUrl: detail.sourceUrl ?? '',
        }
        setInitialListing(current)
        setListing(current)
      })
      .catch(() => {
        if (cancelled) return
        setInitialListing(EMPTY_LISTING)
        setListing({
          ...EMPTY_LISTING,
          summary: extension.description.trim().slice(0, COMMUNITY_LISTING_LIMITS.summary),
        })
      })
      .finally(() => {
        if (!cancelled) setListingLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, account?.handle, extension.id])
  const defaultSourceUrl = community.status
    ? communityExtensionPage(community.status.communityUrl, extension.id)
    : undefined
  const errors = listingErrors(listing)
  const invalid = errors.tags !== undefined || errors.sourceUrl !== undefined
  const edit = (key: keyof ListingDraft) => (event: { readonly target: { readonly value: string } }) =>
    setListing((current) => ({ ...current, [key]: event.target.value }))

  const close = () => {
    if (busy) return
    onOpenChange(false)
    if (published) setNotes('')
  }

  const publish = async () => {
    if (!revision) return
    setBusy(true)
    try {
      setPublished(
        await callHostApi(
          HostApiContracts.publishToCommunity,
          {},
          {
            extensionId: extension.id,
            revisionId: revision.id,
            notes: notes.trim(),
            listing: listingChanges(listing, initialListing, defaultSourceUrl),
          },
        ),
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
      void community.refresh()
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    try {
      await community.signIn()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  if (published) {
    const label = communityReviewLabel(published.reviewStatus)
    // 只列出需要作者留意的检查结果；提示级信息在审查报告里查看。
    const notable = published.findings.filter((finding) => finding.severity !== 'info')
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && close()}
        title="已发布到社区"
        actions={
          <>
            <Button onClick={close}>完成</Button>
            <Button variant="primary" onClick={() => openExternal(published.reportUrl)}>
              查看审查报告
            </Button>
          </>
        }
      >
        <p>
          <Chip tone={label.tone}>{label.label}</Chip>
        </p>
        <p>
          {published.reviewStatus === 'rejected'
            ? '自动检查发现了必须修改的问题，这次发布不会公开。请查看审查报告，修改后重新保存并发布。'
            : '社区正在审查这次发布，通常几分钟内完成。审查报告里有安全、可靠性等方面的建议。'}
        </p>
        {notable.length > 0 ? (
          <ul>
            {notable.slice(0, 6).map((finding, index) => (
              <li key={index}>{finding.title}</li>
            ))}
          </ul>
        ) : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title={`发布「${extension.name}」到社区`}
      wide
      actions={
        account ? (
          <>
            <Button onClick={close} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!revision || !listingLoaded || invalid}
              onClick={() => void publish()}
            >
              发布
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={() => void signIn()}>
              {community.waiting ? '重新打开授权页' : '登录社区'}
            </Button>
          </>
        )
      }
    >
      {community.status === undefined ? (
        <p>正在读取社区账号…</p>
      ) : account ? (
        <>
          <p>
            以 @{account.handle} 发布{revision ? `${relativeTime(revision.createdAt)}的版本` : '最新版本'}
            。所有人都能看到并安装它，同一个扩展再次发布会成为新的一次发布。
          </p>
          <Field label="一句话简介" hint="显示在社区列表的卡片上。">
            <Input
              value={listing.summary}
              maxLength={COMMUNITY_LISTING_LIMITS.summary}
              placeholder="例如：每天早上推送天气和穿衣建议"
              onChange={edit('summary')}
            />
          </Field>
          <Field label="详细介绍" hint="支持 Markdown。写清能做什么、怎么用、需要哪些配置。">
            <Textarea
              value={listing.description}
              maxLength={COMMUNITY_LISTING_LIMITS.description}
              rows={6}
              onChange={edit('description')}
            />
          </Field>
          <Field label="标签" hint={`用逗号或空格分隔，最多 ${COMMUNITY_LISTING_LIMITS.tags} 个。`} error={errors.tags}>
            <Input value={listing.tags} placeholder="天气、提醒" onChange={edit('tags')} />
          </Field>
          <Field label="源码地址" hint="留空时使用这个扩展在社区上的页面。" error={errors.sourceUrl}>
            <Input
              value={listing.sourceUrl}
              inputMode="url"
              placeholder={defaultSourceUrl ?? 'https://'}
              onChange={edit('sourceUrl')}
              onBlur={() => {
                if (!listing.sourceUrl.trim() && defaultSourceUrl) {
                  setListing((current) => ({ ...current, sourceUrl: defaultSourceUrl }))
                }
              }}
            />
          </Field>
          <Field label="更新说明" hint="可选。告诉使用者这次改了什么。">
            <Textarea value={notes} maxLength={2000} rows={3} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <Banner tone="info">
            社区会自动审查源码与权限并给出建议。审查完成前会标注「风险未知」；源码中包含凭据等明确问题时不会公开。
          </Banner>
        </>
      ) : (
        <>
          <p>发布需要先登录社区。登录在浏览器中完成，授权后回到这里继续。</p>
          {community.waiting ? <Banner tone="info">已在浏览器中打开社区授权页，完成后这里会自动更新。</Banner> : null}
        </>
      )}
    </Dialog>
  )
}
