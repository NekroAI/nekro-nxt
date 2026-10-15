import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MessageCircle, Plus, RefreshCw, Send } from 'lucide-react'
import {
  COMMUNITY_FEEDBACK_STATUS_LABELS,
  HostApiContracts,
  type CommunityFeedback,
  type CommunityFeedbackDraft,
  type CommunityFeedbackDraftId,
  type CommunityFeedbackStatus,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  MasterDetail,
  Pressable,
  PropertyGroup,
  Select,
  SelectionList,
  Skeleton,
  SwitchRow,
  Textarea,
  Timeline,
  toast,
} from '../../ui-kit/index.js'
import { FeedbackPrivacy } from '../settings/feedback-section.js'
import { relativeTime } from '../channels/timeline-model.js'
import { errorMessage, type CommunityState } from './community-model.js'
import { feedbackScope, feedbackVersionReached, useFeedbackQuery, useFeedbackSummary } from './feedback-model.js'
import styles from './feedback.module.css'

const ended = (status: CommunityFeedbackStatus) => ['fixed', 'wontfix', 'duplicate', 'withdrawn'].includes(status)
const statusTone = (status: CommunityFeedbackStatus) =>
  status === 'fixed'
    ? 'ok'
    : status === 'needs_info'
      ? 'warn'
      : status === 'triaged' || status === 'planned'
        ? 'accent'
        : 'neutral'
const draftLabel = (draft: CommunityFeedbackDraft) =>
  draft.state === 'failed' ? '发送失败' : draft.state === 'sending' ? '正在发送' : '待确认'
const fail = (error: unknown) => toast(errorMessage(error), { tone: 'bad' })

export function FeedbackView({ community }: { readonly community: CommunityState }) {
  const scope = feedbackScope(community)
  const [params, setParams] = useSearchParams()
  const summary = useFeedbackSummary()
  const settings = useFeedbackQuery(
    `settings:${scope}`,
    (signal) => callHostApi(HostApiContracts.getCommunityFeedbackSettings, {}, undefined, { signal }),
    community.status !== undefined,
  )
  const list = useFeedbackQuery(
    `list:${scope}`,
    (signal) => callHostApi(HostApiContracts.listCommunityFeedback, { refresh: '1' }, undefined, { signal }),
    community.status !== undefined,
  )
  const draftId = params.get('draft')
  const ref = params.get('ref')
  const creating = params.get('new') === '1'
  const selected = creating ? 'new' : (draftId ?? ref ?? undefined)
  const draft = list.data?.drafts.find((item) => item.id === draftId)
  const pending = list.data?.drafts.filter((item) => ['awaiting', 'sending', 'failed'].includes(item.state)) ?? []
  const open = list.data?.items.filter((item) => !ended(item.status)) ?? []
  const closed = list.data?.items.filter((item) => ended(item.status)) ?? []
  const refresh = () => list.refresh().catch(fail)
  useEffect(() => {
    if (community.status) void list.refresh(true).catch(() => undefined)
  }, [summary.pendingDrafts, summary.unread])
  const sent = async (id: CommunityFeedbackDraftId) => {
    try {
      const result = await list.refresh(true)
      const item = result.items.find((candidate) => candidate.draftId === id)
      setParams(item ? { ref: item.ref } : {})
    } catch {
      toast('反馈已发送，列表暂时无法刷新。')
    }
  }
  const head = (
    <div className={styles.head}>
      <h1 className={styles.title}>反馈</h1>
      <div className={styles.actions}>
        <Button size="small" icon={<RefreshCw size={14} />} busy={list.loading} onClick={() => void refresh()}>
          刷新
        </Button>
        <Button size="small" variant="primary" icon={<Plus size={14} />} onClick={() => setParams({ new: '1' })}>
          新建反馈
        </Button>
      </div>
    </div>
  )
  const renderItems = (title: string, items: typeof open) =>
    items.length ? (
      <PropertyGroup title={title}>
        <SelectionList selectedKey={selected}>
          {items.map((item) => (
            <Pressable
              key={item.ref}
              data-key={item.ref}
              data-selected={ref === item.ref}
              className={styles.row}
              onClick={() => setParams({ ref: item.ref })}
            >
              <span>
                <span className={styles.rowTitle}>{item.title}</span>
                <span className={styles.rowMeta}>
                  {item.unread ? <span className={styles.unread} aria-label="未读" /> : null}
                  {item.ref} · {relativeTime(item.updatedAt)}
                </span>
              </span>
              <Chip tone={statusTone(item.status)}>{COMMUNITY_FEEDBACK_STATUS_LABELS[item.status]}</Chip>
            </Pressable>
          ))}
        </SelectionList>
      </PropertyGroup>
    ) : null
  const listView = (
    <div className={styles.stack}>
      {head}
      {!community.status?.account ? (
        <Banner
          tone="info"
          action={
            <Button size="small" onClick={() => void community.signIn().catch(fail)}>
              登录社区
            </Button>
          }
        >
          登录后可以发送反馈。
        </Banner>
      ) : null}
      {settings.data && !settings.data.supported ? (
        <Banner tone="warn">当前社区不支持反馈，草稿仍可编辑。</Banner>
      ) : null}
      {list.error || list.data?.syncError ? <Banner tone="bad">{list.error || list.data?.syncError}</Banner> : null}
      {!list.data && list.loading ? <Skeleton height={100} /> : null}
      {pending.length ? (
        <PropertyGroup title="待确认">
          <SelectionList selectedKey={selected}>
            {pending.map((item) => (
              <Pressable
                key={item.id}
                data-key={item.id}
                data-selected={draftId === item.id}
                className={styles.row}
                onClick={() => setParams({ draft: item.id })}
              >
                <span>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowMeta}>{relativeTime(item.createdAt)}</span>
                </span>
                <Chip tone={item.state === 'failed' ? 'warn' : 'neutral'}>{draftLabel(item)}</Chip>
              </Pressable>
            ))}
          </SelectionList>
        </PropertyGroup>
      ) : null}
      {renderItems('进行中', open)}
      {renderItems('已解决', closed)}
      {list.data && pending.length + open.length + closed.length === 0 ? (
        <EmptyState icon={<MessageCircle size={22} />} title="还没有反馈">
          可以新建反馈，或对智能体说“把这个问题反馈到社区”。
          {settings.data?.enabled === false ? (
            <>
              {' '}
              <Link to="/settings/feedback">开启社区反馈工具</Link>
            </>
          ) : null}
        </EmptyState>
      ) : null}
    </div>
  )
  return (
    <MasterDetail
      label="社区反馈列表"
      selectedKey={selected}
      back={{ label: '全部反馈', onBack: () => setParams({}) }}
      list={listView}
      detail={
        creating || draft ? (
          <FeedbackDraftForm
            key={draft?.id ?? 'new'}
            draft={draft}
            community={community}
            settings={settings.data}
            onSaved={async (next) => {
              await list.refresh(true)
              setParams({ draft: next.id })
            }}
            onSent={sent}
            onDiscarded={() => {
              setParams({})
              void refresh()
            }}
          />
        ) : draftId ? (
          <Banner tone={list.loading ? 'info' : 'warn'}>
            {list.loading ? '正在读取草稿…' : '当前账号没有这条草稿。'}
          </Banner>
        ) : ref ? (
          <FeedbackDetail key={`${scope}:${ref}`} refId={ref} scope={scope} onChanged={() => void refresh()} />
        ) : undefined
      }
    />
  )
}

function FeedbackDraftForm({
  draft,
  community,
  settings,
  onSaved,
  onSent,
  onDiscarded,
}: {
  readonly draft: CommunityFeedbackDraft | undefined
  readonly community: CommunityState
  readonly settings: HostApiResponse<'getCommunityFeedbackSettings'> | undefined
  readonly onSaved: (draft: CommunityFeedbackDraft) => Promise<void>
  readonly onSent: (id: CommunityFeedbackDraftId) => Promise<void>
  readonly onDiscarded: () => void
}) {
  const [record, setRecord] = useState(draft)
  const [title, setTitle] = useState(draft?.title ?? '')
  const [body, setBody] = useState(draft?.body ?? '')
  const [kind, setKind] = useState<'bug' | 'suggestion' | 'question'>(draft?.kind ?? 'bug')
  const [target, setTarget] = useState(draft?.target === 'nxt' || !draft ? 'nxt' : draft.target.extensionId)
  const [includeExcerpt, setIncludeExcerpt] = useState(Boolean(draft?.excerpt?.length))
  const [shareExcerpt, setShareExcerpt] = useState(draft?.excerptSharedWithAuthor ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<HostApiResponse<'previewCommunityFeedbackPayload'>>()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [consent, setConsent] = useState(false)
  const extensions = useProductStore((state) => state.extensions)
  const published = extensions.filter((extension) =>
    extension.revisions.some((revision) => revision.source?.communityUrl === community.status?.communityUrl),
  )
  const dirty =
    record === undefined ||
    title !== record.title ||
    body !== record.body ||
    includeExcerpt !== Boolean(record.excerpt?.length) ||
    shareExcerpt !== record.excerptSharedWithAuthor
  const editable = record === undefined || ['awaiting', 'failed'].includes(record.state)
  const valid = title.trim().length > 0 && body.trim().length > 0
  useEffect(() => {
    if (draft && !dirty) {
      setRecord(draft)
      setTitle(draft.title)
      setBody(draft.body)
      setIncludeExcerpt(Boolean(draft.excerpt?.length))
      setShareExcerpt(draft.excerptSharedWithAuthor)
    }
  }, [draft?.updatedAt])
  const save = async (): Promise<CommunityFeedbackDraft> => {
    const next = record
      ? await callHostApi(
          HostApiContracts.updateCommunityFeedbackDraft,
          { draftId: record.id },
          { title, body, includeExcerpt, excerptSharedWithAuthor: shareExcerpt, expectedUpdatedAt: record.updatedAt },
        )
      : await callHostApi(
          HostApiContracts.createCommunityFeedbackDraft,
          {},
          { kind, target: target === 'nxt' ? 'nxt' : { extensionId: target }, title, body },
        )
    setRecord(next)
    setTitle(next.title)
    setBody(next.body)
    setIncludeExcerpt(Boolean(next.excerpt?.length))
    setShareExcerpt(next.excerptSharedWithAuthor)
    return next
  }
  const saveOnly = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await save()
      await onSaved(next)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  const showPreview = async () => {
    setBusy(true)
    setError('')
    try {
      const current = dirty ? await save() : record
      setPreview(
        await callHostApi(HostApiContracts.previewCommunityFeedbackPayload, { draftId: current.id }, undefined),
      )
      setPreviewOpen(true)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  if (!editable)
    return (
      <div className={styles.stack}>
        <h2 className={styles.title}>{record?.title}</h2>
        <Banner tone="info">
          {record?.state === 'sent' ? '反馈已发送。' : record?.state === 'sending' ? '反馈正在发送。' : '草稿已丢弃。'}
        </Banner>
      </div>
    )
  return (
    <div className={styles.stack}>
      <h2 className={styles.title}>{record ? '反馈草稿' : '新建反馈'}</h2>
      {record?.error || error ? <Banner tone="bad">{error || record?.error}</Banner> : null}
      <div className={styles.form}>
        <Field label="类型">
          <Select
            value={kind}
            disabled={Boolean(record) || busy}
            onValueChange={(value) =>
              setKind(value === 'suggestion' ? 'suggestion' : value === 'question' ? 'question' : 'bug')
            }
            options={[
              { value: 'bug', label: '问题' },
              { value: 'suggestion', label: '建议' },
              { value: 'question', label: '提问' },
            ]}
          />
        </Field>
        <Field label="反馈对象">
          <Select
            value={target}
            disabled={Boolean(record) || busy}
            onValueChange={setTarget}
            options={[
              { value: 'nxt', label: 'NekroNXT' },
              ...published.map((extension) => ({ value: extension.id, label: extension.name })),
              ...(target !== 'nxt' && !published.some((extension) => extension.id === target)
                ? [{ value: target, label: '扩展反馈' }]
                : []),
            ]}
          />
        </Field>
        <Field label="标题">
          <Input disabled={busy} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="正文">
          <Textarea
            disabled={busy}
            value={body}
            maxLength={8000}
            rows={8}
            onChange={(event) => setBody(event.target.value)}
            placeholder="发生了什么、期望什么、怎样复现"
          />
        </Field>
        {record?.excerpt?.length ? (
          <>
            <SwitchRow title="附上选中的对话摘录" checked={includeExcerpt} onCheckedChange={setIncludeExcerpt} />
            {includeExcerpt ? (
              <>
                <blockquote className={styles.excerpt}>
                  {record.excerpt.map((entry) => `${entry.speaker}：${entry.text}`).join('\n')}
                </blockquote>
                {record.target !== 'nxt' ? (
                  <SwitchRow
                    title="允许相关扩展作者查看摘录"
                    checked={shareExcerpt}
                    onCheckedChange={setShareExcerpt}
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        <div className={styles.actions}>
          {dirty ? (
            <Button
              variant={record ? 'default' : 'primary'}
              busy={busy}
              disabled={!valid}
              onClick={() => void saveOnly()}
            >
              保存草稿
            </Button>
          ) : null}
          {record ? (
            <Button
              variant="primary"
              icon={<Send size={14} />}
              busy={busy}
              disabled={!valid || !settings?.supported || !settings.signedIn}
              onClick={() => void showPreview()}
            >
              预览并发送
            </Button>
          ) : null}
          {record ? (
            <Button variant="danger" disabled={busy} onClick={() => setDiscarding(true)}>
              丢弃
            </Button>
          ) : null}
        </div>
        {!settings?.signedIn ? <p className={styles.muted}>草稿可以先保存，登录社区后再发送。</p> : null}
      </div>
      <ConfirmDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="确认发送反馈"
        confirmLabel="发送反馈"
        confirmDisabled={!settings?.consentedAt && !consent}
        onConfirm={async () => {
          if (!record) throw new Error('请先保存草稿。')
          const result = await callHostApi(
            HostApiContracts.sendCommunityFeedbackDraft,
            { draftId: record.id },
            { consent },
          )
          setRecord(result)
          if (result.state !== 'sent') throw new Error(result.error ?? '发送尚未完成，请稍后重试。')
          toast('反馈已发送')
          setPreviewOpen(false)
          void onSent(result.id)
        }}
      >
        {preview ? (
          <div className={styles.stack}>
            <p className={styles.muted}>发送到 {record?.communityUrl}</p>
            <h3 className={styles.previewTitle}>{preview.payload.title}</h3>
            <p className={styles.prose}>{preview.payload.body}</p>
            {preview.payload.excerpt ? (
              <blockquote className={styles.excerpt}>
                {preview.payload.excerpt.map((entry) => `${entry.speaker}：${entry.text}`).join('\n')}
              </blockquote>
            ) : null}
            <PayloadDisclosure title="将发送的完整内容" value={preview.payload} />
            {!settings?.consentedAt ? (
              <>
                <FeedbackPrivacy />
                <SwitchRow title="我已阅读并同意反馈说明" checked={consent} onCheckedChange={setConsent} />
              </>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="丢弃这条草稿？"
        confirmLabel="丢弃"
        danger
        onConfirm={async () => {
          if (!record) return
          await callHostApi(HostApiContracts.discardCommunityFeedbackDraft, { draftId: record.id }, undefined)
          onDiscarded()
        }}
      >
        草稿不会发送到社区。
      </ConfirmDialog>
    </div>
  )
}

function PayloadDisclosure({ title, value }: { readonly title: string; readonly value: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.stack}>
      <Button
        className={styles.payloadToggle}
        size="small"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? '收起' : '查看'}
        {title}
      </Button>
      {open ? <pre className={styles.payload}>{JSON.stringify(value, null, 2)}</pre> : null}
    </div>
  )
}

function FeedbackDetail({
  refId,
  scope,
  onChanged,
}: {
  readonly refId: string
  readonly scope: string
  readonly onChanged: () => void
}) {
  const query = useFeedbackQuery(`detail:${scope}:${refId}`, (signal) =>
    callHostApi(HostApiContracts.getCommunityFeedback, { ref: refId }, undefined, { signal }),
  )
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [deleteText, setDeleteText] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [reason, setReason] = useState('')
  const [marking, setMarking] = useState(false)
  const version = useProductStore((state) => state.productMetadata?.version)
  const summary = useFeedbackSummary()
  useEffect(() => {
    if (summary.unread > 0) void query.refresh(true).catch(() => undefined)
  }, [summary.unread])
  const data = query.data
  const apply = (next: CommunityFeedback) => {
    query.replace(next)
    onChanged()
  }
  const run = async (operation: () => Promise<CommunityFeedback>) => {
    setBusy(true)
    try {
      apply(await operation())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  if (!data)
    return query.error ? (
      <Banner
        tone="bad"
        action={
          <Button size="small" onClick={() => void query.refresh().catch(() => undefined)}>
            重试
          </Button>
        }
      >
        {query.error}
      </Banner>
    ) : (
      <Skeleton height={160} />
    )
  const own = data.access === 'owner'
  const canReopen =
    own &&
    ['fixed', 'wontfix'].includes(data.status) &&
    data.closedAt != null &&
    Date.now() - data.closedAt <= 30 * 86400000
  const events = data.events ?? []
  const messages = data.messages ?? []
  const timeline = [...events].reverse().map((event) => {
    const message =
      event.type === 'message' || event.type === 'reopened'
        ? messages.find((entry) => entry.id === event.data.messageId)
        : undefined
    const text = message
      ? message.body || '说明已删除'
      : event.type === 'status_changed'
        ? `状态改为「${COMMUNITY_FEEDBACK_STATUS_LABELS[event.data.to ?? data.status]}」${event.data.fixedIn ? `，修复版本 ${event.data.fixedIn}` : ''}`
        : event.type === 'created'
          ? '已提交反馈'
          : event.type === 'fix_confirmed'
            ? '已确认问题解决'
            : event.type === 'supplemented'
              ? '已补充诊断或摘录'
              : event.type === 'withdrawn'
                ? '已撤回反馈'
                : event.type === 'reopened'
                  ? '已重新打开反馈'
                  : '反馈有更新'
    return {
      key: String(event.seq),
      tag: new Date(event.createdAt).toLocaleDateString(),
      text: <p className={styles.prose}>{text}</p>,
      meta: event.data.note ?? event.actor,
    }
  })
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <h2 className={styles.title}>{data.title}</h2>
        <Chip tone={statusTone(data.status)}>{COMMUNITY_FEEDBACK_STATUS_LABELS[data.status]}</Chip>
      </div>
      <p className={styles.muted}>
        {data.ref}
        {data.fixedIn ? ` · 修复版本 ${data.fixedIn}` : ''}
      </p>
      {data.body ? <p className={styles.prose}>{data.body}</p> : null}
      {data.diagnostics ? <PayloadDisclosure title="诊断信息" value={data.diagnostics} /> : null}
      {data.excerpt?.length ? (
        <PropertyGroup title="对话摘录">
          <blockquote className={styles.excerpt}>
            {data.excerpt.map((entry) => `${entry.speaker}：${entry.text}`).join('\n')}
          </blockquote>
        </PropertyGroup>
      ) : null}
      {timeline.length ? (
        <PropertyGroup title="进展">
          <Timeline entries={timeline} />
        </PropertyGroup>
      ) : null}
      {data.status === 'fixed' && feedbackVersionReached(version, data.fixedIn) ? (
        <Banner tone="ok">可以确认是否已解决。</Banner>
      ) : null}
      <div className={styles.actions}>
        {data.status === 'fixed' && (own || (data.access === 'subscriber' && data.affected)) ? (
          <Button
            disabled={data.confirmed || busy}
            busy={busy}
            onClick={() =>
              void run(() => callHostApi(HostApiContracts.confirmCommunityFeedbackFixed, { ref: refId }, {}))
            }
          >
            {data.confirmed ? '已确认解决' : '已解决'}
          </Button>
        ) : null}
        {canReopen ? (
          <Button disabled={busy} onClick={() => setReopening(true)}>
            重新打开
          </Button>
        ) : null}
        {own && !ended(data.status) ? (
          <Button variant="danger" disabled={busy} onClick={() => setWithdrawing(true)}>
            撤回
          </Button>
        ) : null}
        {data.access === 'public' && data.status !== 'withdrawn' ? (
          <Button busy={busy} onClick={() => setMarking(true)}>
            我也遇到
          </Button>
        ) : null}
        {data.affected && data.status !== 'withdrawn' ? (
          <Button
            busy={busy}
            variant="ghost"
            onClick={() =>
              void run(() =>
                callHostApi(
                  HostApiContracts.markCommunityFeedbackAffected,
                  { ref: refId },
                  { affected: false, consent: false },
                ),
              )
            }
          >
            取消标记
          </Button>
        ) : null}
      </div>
      {own && data.status !== 'withdrawn' ? (
        <PropertyGroup title="追加说明">
          <div className={styles.form}>
            <Textarea
              aria-label="追加说明"
              rows={4}
              maxLength={4000}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <div>
              <Button
                disabled={!reply.trim()}
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    const next = await callHostApi(
                      HostApiContracts.replyCommunityFeedback,
                      { ref: refId },
                      { body: reply },
                    )
                    setReply('')
                    return next
                  })
                }
              >
                发送说明
              </Button>
            </div>
          </div>
        </PropertyGroup>
      ) : null}
      <ConfirmDialog
        open={marking}
        onOpenChange={setMarking}
        title="标记我也遇到"
        confirmLabel="同意并标记"
        onConfirm={async () =>
          apply(
            await callHostApi(
              HostApiContracts.markCommunityFeedbackAffected,
              { ref: refId },
              { affected: true, consent: true },
            ),
          )
        }
      >
        <p>将订阅状态和修复版本的变化，并附上当前版本和运行环境。诊断会在取消标记或结束处理 180 天后清除。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title="撤回这条反馈？"
        confirmLabel="撤回"
        danger
        onConfirm={async () =>
          apply(await callHostApi(HostApiContracts.withdrawCommunityFeedback, { ref: refId }, { deleteText }))
        }
      >
        <p>诊断与摘录会被清除。撤回后不能继续修改或恢复。</p>
        <SwitchRow title="同时删除标题、正文和我追加的说明" checked={deleteText} onCheckedChange={setDeleteText} />
      </ConfirmDialog>
      <ConfirmDialog
        open={reopening}
        onOpenChange={setReopening}
        title="重新打开反馈"
        confirmLabel="重新打开"
        confirmDisabled={!reason.trim()}
        onConfirm={async () =>
          apply(await callHostApi(HostApiContracts.reopenCommunityFeedback, { ref: refId }, { note: reason }))
        }
      >
        <Field label="原因">
          <Textarea rows={4} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  )
}
