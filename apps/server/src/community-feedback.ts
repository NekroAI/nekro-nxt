import {
  CommunityFeedbackCreateSchema,
  CommunityFeedbackDraftIdSchema,
  CommunityFeedbackDraftInputSchema,
  CommunityFeedbackDraftSchema,
  CommunityFeedbackDraftUpdateSchema,
  CommunityFeedbackLastPayloadSchema,
  CommunityFeedbackSettingsSchema,
  CommunityFeedbackMessageInputSchema,
  CommunityFeedbackReopenSchema,
  JsonValueSchema,
  type AgentId,
  type ChannelId,
  type CommunityFeedback,
  type CommunityFeedbackCreate,
  type CommunityFeedbackDiagnostics,
  type CommunityFeedbackDraft,
  type CommunityFeedbackDraftId,
  type CommunityFeedbackDraftInput,
  type CommunityFeedbackItem,
  type CommunityFeedbackSettings,
  type CommunityFeedbackSummary,
} from '@nekro-nxt/contracts'
import { isAdminConsoleOutbound } from '@nekro-nxt/channel-runtime'
import type { CommunityFeedbackIdentity, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CommunityError, type CommunityService } from './community.js'
import {
  collectFeedbackDiagnostics,
  feedbackMessageText,
  feedbackRedactions,
  redactFeedbackExcerpt,
  redactFeedbackText,
  type FeedbackRedactionContext,
} from './feedback-payload.js'

const SETTINGS_KEY = 'community.feedback'
const StoredSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    consentedAt: z.number().int().optional(),
    instanceId: z.string().optional(),
  })
  .strict()
const CursorSchema = z.object({ version: z.literal(1), cursor: z.number().int().nonnegative() }).strict()
const StoredLastPayloadSchema = z.object({ version: z.literal(1), value: CommunityFeedbackLastPayloadSchema }).strict()
const scopeKey = (identity: CommunityFeedbackIdentity): string =>
  JSON.stringify([identity.communityUrl, identity.communityUserId])
const storedKey = (kind: 'cursor' | 'lastSent', identity: CommunityFeedbackIdentity): string =>
  `community.feedback.${kind}:${scopeKey(identity)}`
const sameIdentity = (left: CommunityFeedbackIdentity, right: CommunityFeedbackIdentity): boolean =>
  scopeKey(left) === scopeKey(right)

export interface FeedbackDraftContext {
  readonly agentId: AgentId | null
  readonly channelId: ChannelId | null
  readonly requestedBy: string
  readonly automatic?: boolean
  readonly signal?: AbortSignal
}
export interface FeedbackSources {
  readonly redaction: (channelId: ChannelId | null) => FeedbackRedactionContext
  readonly diagnostics: (agentId: AgentId | null) => CommunityFeedbackDiagnostics
  readonly canAutoSubmit?: (agentId: AgentId, channelId: ChannelId) => boolean
  readonly notify?: (input: { readonly kind: 'draft' | 'update'; readonly ref?: string }) => Promise<unknown>
}

/** Owns local drafts and mirrors. Remote operations are always bound to the identity captured before awaiting. */
export class CommunityFeedbackService {
  readonly #repository: SqliteCoreRepository
  readonly #community: CommunityService
  readonly #sources: FeedbackSources
  readonly #now: () => number
  readonly #listeners = new Set<() => void>()
  readonly #sending = new Map<CommunityFeedbackDraftId, Promise<CommunityFeedbackDraft>>()
  readonly #syncing = new Map<string, Promise<void>>()
  #supportedUrl: string | undefined
  #disposed = false

  constructor(
    repository: SqliteCoreRepository,
    community: CommunityService,
    sources: FeedbackSources,
    now: () => number = Date.now,
  ) {
    this.#repository = repository
    this.#community = community
    this.#sources = sources
    this.#now = now
    repository.communityFeedback.recoverSending(now())
  }

  #stored(): z.output<typeof StoredSettingsSchema> {
    const record = this.#repository.getSystemSetting(SETTINGS_KEY)
    return record ? StoredSettingsSchema.parse(record.value) : { version: 1, enabled: false }
  }
  #writeSettings(value: z.output<typeof StoredSettingsSchema>): void {
    const current = this.#repository.getSystemSetting(SETTINGS_KEY)
    this.#repository.putSystemSetting(SETTINGS_KEY, JsonValueSchema.parse(value), current?.revision, this.#now())
  }
  #instanceId(): string {
    const current = this.#stored()
    if (current.instanceId) return current.instanceId
    const instanceId = `nxt_feedback_${randomUUID().replaceAll('-', '')}`
    this.#writeSettings({ ...current, instanceId })
    return instanceId
  }
  #assertActive(): void {
    if (this.#disposed) throw new Error('Community feedback service is disposed.')
  }
  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[nekro-nxt] Feedback observer failed:', error)
      }
    }
  }
  async #notify(input: { readonly kind: 'draft' | 'update'; readonly ref?: string }): Promise<void> {
    try {
      await this.#sources.notify?.(input)
    } catch {
      console.warn('[nekro-nxt] Feedback notification delivery failed.')
    }
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async initialize(): Promise<void> {
    if (this.#stored().enabled) await this.getSettings().catch(() => undefined)
  }
  enabled(): boolean {
    return (
      this.#stored().enabled &&
      this.#supportedUrl === this.#community.communityUrl &&
      this.#community.feedbackIdentity().communityUserId !== null
    )
  }
  snapshot() {
    const identity = this.#community.feedbackIdentity()
    return {
      enabled: this.enabled(),
      signedIn: identity.communityUserId !== null,
      pendingDrafts: this.#repository.communityFeedback
        .listDrafts(identity)
        .filter((draft) => draft.state === 'awaiting' || draft.state === 'failed').length,
      unread: this.#repository.communityFeedback.listItems(identity).filter((item) => item.unread).length,
    }
  }

  async getSettings(): Promise<CommunityFeedbackSettings> {
    this.#assertActive()
    const url = this.#community.communityUrl
    const meta = await this.#community.meta()
    if (url !== this.#community.communityUrl) return this.getSettings()
    const supported = meta?.features.includes('feedback') === true
    this.#supportedUrl = supported ? url : undefined
    const identity = supported ? await this.#community.ensureFeedbackIdentity() : this.#community.feedbackIdentity()
    const settings = this.#stored()
    return CommunityFeedbackSettingsSchema.parse({
      enabled: settings.enabled,
      supported,
      signedIn: identity.communityUserId !== null,
      communityUrl: identity.communityUrl,
      communityUserId: identity.communityUserId,
      consentedAt: settings.consentedAt ?? null,
    })
  }

  async updateSettings(enabled: boolean, consent: boolean): Promise<CommunityFeedbackSettings> {
    this.#assertActive()
    const current = this.#stored()
    if (enabled) {
      const view = await this.getSettings()
      if (!view.supported) throw new Error('当前社区不支持反馈。')
      if (!view.signedIn) throw new Error('请先登录社区。')
      if (!current.consentedAt && !consent) throw new Error('请先阅读并同意反馈说明。')
    }
    this.#writeSettings({
      ...current,
      enabled,
      ...(enabled ? { instanceId: this.#instanceId(), consentedAt: current.consentedAt ?? this.#now() } : {}),
    })
    this.#changed()
    return this.getSettings()
  }

  #draft(id: CommunityFeedbackDraftId): CommunityFeedbackDraft {
    const draft = this.#repository.communityFeedback.getDraft(id)
    const identity = this.#community.feedbackIdentity()
    if (
      !draft ||
      draft.communityUrl !== identity.communityUrl ||
      (draft.communityUserId !== null && draft.communityUserId !== identity.communityUserId)
    ) {
      throw new CommunityError(404, '草稿不存在。', 'feedback-draft-not-found')
    }
    return draft
  }

  async createDraft(
    input: CommunityFeedbackDraftInput,
    context: FeedbackDraftContext = { agentId: null, channelId: null, requestedBy: 'admin-console' },
  ): Promise<CommunityFeedbackDraft> {
    this.#assertActive()
    context.signal?.throwIfAborted()
    const value = CommunityFeedbackDraftInputSchema.parse(input)
    if (context.agentId !== null) {
      await this.getSettings()
      if (!this.enabled()) throw new Error('社区反馈工具尚未开启。')
    }
    context.signal?.throwIfAborted()
    const identity = this.#community.feedbackIdentity()
    const redaction = this.#sources.redaction(context.channelId)
    const excerpt = (value.conversationRefs ?? []).map((messageId) => {
      if (context.channelId === null) throw new Error('只能附上当前频道的消息。')
      const entry = this.#repository.getChannelHistoryEntryByLogicalMessageId(context.channelId, messageId)
      if (!entry || (entry.source === 'channel-event' && entry.facts?.['consoleAnchor'] === true))
        throw new Error('有消息不属于当前频道，或已不可读取。')
      const speaker =
        entry.source === 'channel-event' && entry.senderMemberId
          ? (this.#repository.getChannelMember(entry.senderMemberId)?.displayName ?? '成员')
          : entry.source === 'outbound-intent' && isAdminConsoleOutbound(entry.sourceTurnId)
            ? '管理员'
            : '智能体'
      return { speaker, text: feedbackMessageText(entry.parts) }
    })
    const time = this.#now()
    const draft = CommunityFeedbackDraftSchema.parse({
      id: `fbd_${randomUUID().replaceAll('-', '')}`,
      ...identity,
      agentId: context.agentId,
      channelId: context.channelId,
      kind: value.kind,
      target: value.target,
      title: redactFeedbackText(value.title, redaction),
      body: redactFeedbackText(value.body, redaction),
      excerpt: excerpt.length ? redactFeedbackExcerpt(excerpt, redaction) : null,
      excerptSharedWithAuthor: false,
      diagnostics: collectFeedbackDiagnostics(this.#sources.diagnostics(context.agentId), redaction),
      state: 'awaiting',
      requestedBy: context.requestedBy,
      auto: false,
      error: null,
      createdAt: time,
      updatedAt: time,
    })
    this.#repository.communityFeedback.insertDraft(draft)
    this.#changed()
    if (
      context.automatic === true &&
      context.agentId !== null &&
      context.channelId !== null &&
      context.requestedBy === 'admin-console' &&
      this.#sources.canAutoSubmit?.(context.agentId, context.channelId) === true
    ) {
      return this.sendDraft(draft.id, { automatic: true, ...(context.signal ? { signal: context.signal } : {}) })
    }
    await this.#notify({ kind: 'draft' })
    return draft
  }

  updateDraft(
    id: CommunityFeedbackDraftId,
    input: z.output<typeof CommunityFeedbackDraftUpdateSchema>,
  ): CommunityFeedbackDraft {
    this.#assertActive()
    const value = CommunityFeedbackDraftUpdateSchema.parse(input)
    const draft = this.#draft(id)
    if (!['awaiting', 'failed'].includes(draft.state)) throw new Error('这条草稿现在不能修改。')
    const context = this.#sources.redaction(draft.channelId)
    const next = {
      ...draft,
      title: redactFeedbackText(value.title, context),
      body: redactFeedbackText(value.body, context),
      excerpt: value.includeExcerpt ? draft.excerpt : null,
      excerptSharedWithAuthor: value.includeExcerpt && value.excerptSharedWithAuthor,
      state: 'awaiting' as const,
      auto: false,
      error: null,
      updatedAt: Math.max(this.#now(), draft.updatedAt + 1),
    }
    this.#repository.communityFeedback.replaceDraft(next, value.expectedUpdatedAt)
    this.#changed()
    return next
  }

  discardDraft(id: CommunityFeedbackDraftId): CommunityFeedbackDraft {
    const draft = this.#draft(id)
    if (!['awaiting', 'failed'].includes(draft.state)) throw new Error('这条草稿现在不能丢弃。')
    const next = { ...draft, state: 'discarded' as const, updatedAt: Math.max(this.#now(), draft.updatedAt + 1) }
    this.#repository.communityFeedback.replaceDraft(next, draft.updatedAt)
    this.#changed()
    return next
  }

  previewDraft(id: CommunityFeedbackDraftId) {
    const draft = this.#draft(id)
    const context = this.#sources.redaction(draft.channelId)
    const instanceId = this.#instanceId()
    const payload = CommunityFeedbackCreateSchema.parse({
      clientRequestId: draft.id,
      kind: draft.kind,
      target: draft.target,
      title: redactFeedbackText(draft.title, context),
      body: redactFeedbackText(draft.body, context),
      diagnostics: { ...collectFeedbackDiagnostics(draft.diagnostics, context), instanceId },
      ...(draft.excerpt === null ? {} : { excerpt: redactFeedbackExcerpt(draft.excerpt, context) }),
      excerptSharedWithAuthor: draft.excerpt !== null && draft.excerptSharedWithAuthor,
      source: draft.agentId === null ? 'form' : draft.auto ? 'assistant_auto' : 'assistant',
      instanceId,
    })
    return { payload, redactions: feedbackRedactions(payload) }
  }

  async sendDraft(
    id: CommunityFeedbackDraftId,
    options: { readonly automatic?: boolean; readonly consent?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<CommunityFeedbackDraft> {
    this.#assertActive()
    this.#draft(id)
    const active = this.#sending.get(id)
    if (active) return active
    const operation = this.#send(id, options).finally(() => {
      this.#sending.delete(id)
    })
    this.#sending.set(id, operation)
    return operation
  }

  async #send(
    id: CommunityFeedbackDraftId,
    options: { readonly automatic?: boolean; readonly consent?: boolean; readonly signal?: AbortSignal },
  ): Promise<CommunityFeedbackDraft> {
    options.signal?.throwIfAborted()
    const settings = await this.getSettings()
    options.signal?.throwIfAborted()
    if (!settings.supported) throw new Error('当前社区不支持反馈。')
    if (!settings.signedIn) throw new Error('请先登录社区。')
    const identity = this.#community.feedbackIdentity()
    const stored = this.#stored()
    if (!stored.consentedAt) {
      if (!options.consent) throw new Error('请先阅读并同意反馈说明。')
      this.#writeSettings({ ...stored, consentedAt: this.#now(), instanceId: this.#instanceId() })
    }
    const draft = this.#draft(id)
    if (draft.state === 'sent') return draft
    const automatic = options.automatic === true
    if (automatic) {
      if (
        !this.enabled() ||
        draft.requestedBy !== 'admin-console' ||
        draft.agentId === null ||
        draft.channelId === null ||
        this.#sources.canAutoSubmit?.(draft.agentId, draft.channelId) !== true
      )
        return draft
    }
    const preview = this.previewDraft(id)
    const claimed = this.#repository.communityFeedback.claimSend(id, identity, draft.updatedAt, automatic, this.#now())
    if (claimed === 'quota') {
      await this.#notify({ kind: 'draft' })
      return this.#draft(id)
    }
    const withoutExcerpt = { ...preview.payload }
    delete withoutExcerpt.excerpt
    const payload: CommunityFeedbackCreate = {
      ...(automatic ? withoutExcerpt : preview.payload),
      ...(automatic ? { excerptSharedWithAuthor: false } : {}),
      source: draft.agentId === null ? 'form' : automatic ? 'assistant_auto' : 'assistant',
    }
    this.#changed()
    try {
      const response = await this.#community.createFeedback(identity, payload, options.signal)
      const item = this.#item(identity, response, { channelId: draft.channelId, draftId: draft.id })
      this.#repository.communityFeedback.commitSent(
        id,
        item,
        storedKey('lastSent', identity),
        JsonValueSchema.parse({ version: 1, value: { ref: response.ref, sentAt: this.#now(), payload } }),
        this.#now(),
      )
      this.#changed()
      await this.sync().catch(() => undefined)
    } catch (error) {
      const current = this.#repository.communityFeedback.getDraft(id)
      if (current?.state === 'sending')
        this.#repository.communityFeedback.replaceDraft(
          {
            ...current,
            state:
              error instanceof CommunityError && ['sensitive_secret', 'sensitive_path'].includes(error.code)
                ? 'awaiting'
                : 'failed',
            error: error instanceof Error ? error.message : '发送失败，请稍后重试。',
            updatedAt: Math.max(this.#now(), current.updatedAt + 1),
          },
          current.updatedAt,
        )
      this.#changed()
      if (!sameIdentity(identity, this.#community.feedbackIdentity())) throw error
      return this.#draft(id)
    }
    return this.#draft(id)
  }

  #item(
    identity: CommunityFeedbackIdentity,
    remote: CommunityFeedbackSummary,
    origin?: { channelId: ChannelId | null; draftId: CommunityFeedbackDraftId | null },
    eventSeq?: number,
  ): CommunityFeedbackItem {
    if (identity.communityUserId === null) throw new Error('Feedback mirror requires a signed-in identity.')
    const previous = this.#repository.communityFeedback.getItem(identity, remote.ref)
    const sequence = eventSeq ?? previous?.lastEventSeq ?? 0
    return {
      ...identity,
      communityUserId: identity.communityUserId,
      ref: remote.ref,
      channelId: origin?.channelId ?? previous?.channelId ?? null,
      draftId: origin?.draftId ?? previous?.draftId ?? null,
      title: remote.title,
      kind: remote.kind ?? previous?.kind ?? null,
      target: remote.target ?? previous?.target ?? null,
      status: remote.status,
      fixedIn: remote.fixedIn,
      unread: eventSeq !== undefined && eventSeq > (previous?.lastEventSeq ?? 0) ? true : (previous?.unread ?? false),
      lastEventSeq: sequence,
      createdAt: remote.createdAt ?? previous?.createdAt ?? this.#now(),
      updatedAt: remote.updatedAt ?? previous?.updatedAt ?? this.#now(),
    }
  }

  async list(refresh = false) {
    let syncError: string | undefined
    if (refresh) {
      try {
        await this.sync()
      } catch (error) {
        syncError = error instanceof Error ? error.message : '暂时无法同步社区反馈。'
      }
    }
    const identity = this.#community.feedbackIdentity()
    return {
      drafts: this.#repository.communityFeedback.listDrafts(identity).filter((draft) => draft.state !== 'discarded'),
      items: this.#repository.communityFeedback.listItems(identity),
      ...(syncError === undefined ? {} : { syncError }),
    }
  }
  lastSent() {
    const record = this.#repository.getSystemSetting(storedKey('lastSent', this.#community.feedbackIdentity()))
    return record ? StoredLastPayloadSchema.parse(record.value).value : null
  }

  sentRef(id: CommunityFeedbackDraftId): string | undefined {
    this.#draft(id)
    return this.#repository.communityFeedback
      .listItems(this.#community.feedbackIdentity())
      .find((item) => item.draftId === id)?.ref
  }

  async detail(ref: string): Promise<CommunityFeedback> {
    await this.sync()
    const identity = this.#community.feedbackIdentity()
    const remote = await this.#community.getFeedback(identity, ref)
    this.#repository.communityFeedback.saveItem({ ...this.#item(identity, remote), unread: false })
    this.#changed()
    return remote
  }

  async act(
    ref: string,
    action: 'messages' | 'withdraw' | 'reopen' | 'confirm-fixed' | 'affected',
    value: unknown,
  ): Promise<CommunityFeedback> {
    this.#assertActive()
    const identity = this.#community.feedbackIdentity()
    const context = this.#sources.redaction(null)
    let payload = value
    let method: 'POST' | 'DELETE' = 'POST'
    if (action === 'messages') {
      const input = CommunityFeedbackMessageInputSchema.parse(value)
      payload = { ...input, body: redactFeedbackText(input.body, context) }
    } else if (action === 'reopen') {
      const input = CommunityFeedbackReopenSchema.parse(value)
      payload = { note: redactFeedbackText(input.note, context) }
    } else if (action === 'affected') {
      const input = z
        .object({ affected: z.boolean().default(true), consent: z.boolean().default(false) })
        .strict()
        .parse(value)
      if (identity.communityUserId === null) throw new Error('请先登录社区。')
      if (input.affected) {
        const current = this.#stored()
        if (!current.consentedAt && !input.consent) throw new Error('请先阅读并同意反馈说明。')
        if (!current.consentedAt)
          this.#writeSettings({ ...current, consentedAt: this.#now(), instanceId: this.#instanceId() })
      } else method = 'DELETE'
      const diagnostics = this.#sources.diagnostics(null)
      payload = input.affected
        ? {
            diagnostics: {
              nxtVersion: diagnostics.nxtVersion,
              hostKind: diagnostics.hostKind,
              platform: diagnostics.platform,
              arch: diagnostics.arch,
            },
            nxtVersion: diagnostics.nxtVersion,
          }
        : {}
    } else if (action === 'confirm-fixed') {
      payload = { clientVersion: this.#sources.diagnostics(null).nxtVersion }
    }
    const remote = await this.#community.updateFeedback(identity, ref, action, payload, method)
    if (method === 'DELETE' && remote.access !== 'owner') this.#repository.communityFeedback.removeItem(identity, ref)
    else this.#repository.communityFeedback.saveItem({ ...this.#item(identity, remote), unread: false })
    if (action === 'withdraw' && z.object({ deleteText: z.literal(true) }).safeParse(value).success)
      this.#clearLocalText(identity, ref)
    this.#changed()
    await this.sync().catch(() => undefined)
    const current = this.#repository.communityFeedback.getItem(identity, ref)
    if (current?.unread) {
      this.#repository.communityFeedback.saveItem({ ...current, unread: false })
      this.#changed()
    }
    return remote
  }

  #clearLocalText(identity: CommunityFeedbackIdentity, ref: string): void {
    this.#repository.communityFeedback.clearText(identity, ref, this.#now())
    const key = storedKey('lastSent', identity)
    const record = this.#repository.getSystemSetting(key)
    if (record && StoredLastPayloadSchema.parse(record.value).value?.ref === ref)
      this.#repository.putSystemSetting(key, { version: 1, value: null }, record.revision, this.#now())
  }

  async sync(): Promise<void> {
    this.#assertActive()
    const view = await this.getSettings()
    if (!view.supported || !view.signedIn) return
    const identity = this.#community.feedbackIdentity()
    const key = scopeKey(identity)
    const existing = this.#syncing.get(key)
    if (existing) return existing
    const operation = this.#sync(identity).finally(() => {
      this.#syncing.delete(key)
    })
    this.#syncing.set(key, operation)
    return operation
  }

  async #sync(identity: CommunityFeedbackIdentity): Promise<void> {
    let changed = false
    const key = storedKey('cursor', identity)
    let record = this.#repository.getSystemSetting(key)
    let cursor = record ? CursorSchema.parse(record.value).cursor : undefined
    if (cursor === undefined) {
      cursor = (await this.#community.feedbackChanges(identity)).cursor
      let pageCursor: string | null = null
      do {
        const params = new URLSearchParams({ limit: '100' })
        if (pageCursor) params.set('cursor', pageCursor)
        const page = await this.#community.listFeedback(identity, params)
        changed ||= page.items.length > 0
        for (const remote of page.items) this.#repository.communityFeedback.saveItem(this.#item(identity, remote))
        pageCursor = page.cursor
      } while (pageCursor !== null)
      record = this.#repository.putSystemSetting(key, { version: 1, cursor }, record?.revision, this.#now())
    }
    let more = true
    const notifications = new Set<string>()
    while (more) {
      const page = await this.#community.feedbackChanges(identity, cursor)
      changed ||= page.events.length > 0
      const latest = new Map<string, number>()
      for (const event of page.events) latest.set(event.ref, Math.max(latest.get(event.ref) ?? 0, event.seq))
      for (const [ref, seq] of latest) {
        const previous = this.#repository.communityFeedback.getItem(identity, ref)
        const remote = await this.#community.getFeedback(identity, ref)
        this.#repository.communityFeedback.saveItem(this.#item(identity, remote, undefined, seq))
        if (remote.status === 'withdrawn' && remote.title === '已删除' && remote.body === '')
          this.#clearLocalText(identity, ref)
        if (seq > (previous?.lastEventSeq ?? 0)) notifications.add(ref)
      }
      if (page.cursor < cursor || (page.hasMore && page.cursor === cursor))
        throw new Error('Invalid community feedback cursor progression.')
      cursor = page.cursor
      more = page.hasMore
      record = this.#repository.putSystemSetting(key, { version: 1, cursor }, record?.revision, this.#now())
    }
    if (changed) this.#changed()
    if (sameIdentity(identity, this.#community.feedbackIdentity()))
      for (const ref of notifications) await this.#notify({ kind: 'update', ref })
  }

  async searchForChannel(
    channelId: ChannelId,
    query: string,
    extensionId?: string,
    signal?: AbortSignal,
  ): Promise<CommunityFeedbackSummary[]> {
    signal?.throwIfAborted()
    await this.getSettings()
    signal?.throwIfAborted()
    if (!this.enabled()) throw new Error('社区反馈工具尚未开启。')
    const identity = this.#community.feedbackIdentity()
    const params = new URLSearchParams({ q: query, limit: '50' })
    if (extensionId) params.set('extensionId', extensionId)
    const publicItems = await this.#community.listFeedback(identity, params, true, signal)
    const own = this.#repository.communityFeedback
      .listItems(identity)
      .filter((item) => item.channelId === channelId && item.title.includes(query))
    const results = new Map(publicItems.items.map((item) => [item.ref, item]))
    for (const item of own) {
      const detail = await this.#community.getFeedback(identity, item.ref, signal)
      if (!extensionId || (detail.target !== 'nxt' && detail.target?.extensionId === extensionId))
        results.set(item.ref, {
          id: detail.id,
          ref: detail.ref,
          title: detail.title,
          status: detail.status,
          fixedIn: detail.fixedIn,
          affectedCount: detail.affectedCount,
        })
    }
    return [...results.values()]
  }

  async statusForChannel(channelId: ChannelId, ref?: string, signal?: AbortSignal): Promise<CommunityFeedback[]> {
    signal?.throwIfAborted()
    await this.getSettings()
    signal?.throwIfAborted()
    if (!this.enabled()) throw new Error('社区反馈工具尚未开启。')
    const identity = this.#community.feedbackIdentity()
    const items = this.#repository.communityFeedback
      .listItems(identity)
      .filter((item) => item.channelId === channelId && (!ref || item.ref === ref))
      .slice(0, 10)
    if (ref && items.length === 0) throw new Error('当前频道没有这条反馈。')
    return Promise.all(items.map((item) => this.#community.getFeedback(identity, item.ref, signal)))
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#sending.values(), ...this.#syncing.values()])
    this.#listeners.clear()
  }
}

export { CommunityFeedbackDraftIdSchema }
