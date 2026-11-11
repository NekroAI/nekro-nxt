import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  ClientNotificationSchema,
  JsonValueSchema,
  type ClientNotification,
  type JsonValue,
  type ManagementDeviceId,
} from '@nekro-nxt/contracts'
import type { ManagementDeviceRecord, PushSubscriptionRecord, SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import webPush from 'web-push'
import type { LocalCredentialStore } from './credentials.js'

export const DYNAMIC_CLIENT_APPROVAL_NOTIFICATION = 'dynamic-client-approval-requested' as const
export const COMMUNITY_FEEDBACK_NOTIFICATION = 'community-feedback-update' as const
export const CREDENTIAL_REQUEST_NOTIFICATION = 'credential-requested' as const
export const EXTENSION_NOTIFICATION = 'extension-notification' as const
export type NotificationEventKey =
  | typeof DYNAMIC_CLIENT_APPROVAL_NOTIFICATION
  | typeof COMMUNITY_FEEDBACK_NOTIFICATION
  | typeof CREDENTIAL_REQUEST_NOTIFICATION
  | typeof EXTENSION_NOTIFICATION

const NOTIFICATION_SETTING_KEY = 'notifications'
const WEB_PUSH_KEYS_SETTING_KEY = 'notification-web-push-keys'
const DEFAULT_BARK_SERVER_URL = 'https://api.day.app'
const DEFAULT_NTFY_SERVER_URL = 'https://ntfy.sh'
/** Push services ask for a contact; Apple refuses a localhost one. */
const WEB_PUSH_SUBJECT = 'https://github.com/NekroAI/nekro-nxt'
/** A push the device cannot take within a day is no longer worth showing. */
const WEB_PUSH_TTL_SECONDS = 24 * 60 * 60
const CHANNEL_TIMEOUT_MS = 10_000

const StoredNotificationSettingsSchema = z
  .object({
    version: z.literal(1),
    system: z.object({ enabled: z.boolean() }).strict().default({ enabled: true }),
    bark: z
      .object({
        enabled: z.boolean(),
        serverUrl: z.url(),
        credentialRef: z.string().optional(),
      })
      .strict(),
    browserPush: z.object({ enabled: z.boolean() }).strict().default({ enabled: true }),
    /** The group robot's webhook address carries its key, so the whole address is a credential. */
    wecom: z
      .object({ enabled: z.boolean(), credentialRef: z.string().optional() })
      .strict()
      .default({ enabled: false }),
    /** On a public ntfy server the topic name is what keeps others from reading, so it is a credential too. */
    ntfy: z
      .object({
        enabled: z.boolean(),
        serverUrl: z.url(),
        topicRef: z.string().optional(),
        tokenRef: z.string().optional(),
      })
      .strict()
      .default({ enabled: false, serverUrl: DEFAULT_NTFY_SERVER_URL }),
    events: z
      .object({
        [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: z.boolean(),
        [COMMUNITY_FEEDBACK_NOTIFICATION]: z.boolean().default(true),
        [CREDENTIAL_REQUEST_NOTIFICATION]: z.boolean().default(true),
        [EXTENSION_NOTIFICATION]: z.boolean().default(true),
      })
      .strict(),
  })
  .strict()

type StoredNotificationSettings = z.output<typeof StoredNotificationSettingsSchema>

const StoredWebPushKeysSchema = z
  .object({ version: z.literal(1), publicKey: z.string().min(1), privateKeyRef: z.string().min(1) })
  .strict()

export interface NotificationSettingsView {
  readonly revision?: number
  readonly system: { readonly enabled: boolean }
  readonly bark: {
    readonly enabled: boolean
    readonly serverUrl: string
    readonly deviceKeyConfigured: boolean
  }
  readonly browserPush: { readonly enabled: boolean }
  readonly wecom: { readonly enabled: boolean; readonly webhookConfigured: boolean }
  readonly ntfy: {
    readonly enabled: boolean
    readonly serverUrl: string
    readonly topicConfigured: boolean
    readonly tokenConfigured: boolean
  }
  readonly events: Readonly<Record<NotificationEventKey, boolean>>
}

export interface NotificationSettingsUpdate {
  readonly expectedRevision?: number
  readonly system: { readonly enabled: boolean }
  readonly bark: {
    readonly enabled: boolean
    readonly serverUrl: string
    readonly deviceKey?: string
    readonly clearDeviceKey?: boolean
  }
  /** Channels an older client does not send keep their stored values. */
  readonly browserPush?: { readonly enabled: boolean }
  readonly wecom?: { readonly enabled: boolean; readonly webhookUrl?: string; readonly clearWebhookUrl?: boolean }
  readonly ntfy?: {
    readonly enabled: boolean
    readonly serverUrl: string
    readonly topic?: string
    readonly token?: string
    readonly clearToken?: boolean
  }
  readonly events: Readonly<{
    [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: boolean
    [COMMUNITY_FEEDBACK_NOTIFICATION]?: boolean | undefined
    [CREDENTIAL_REQUEST_NOTIFICATION]?: boolean | undefined
    [EXTENSION_NOTIFICATION]?: boolean | undefined
  }>
}

export interface BarkTestInput {
  readonly serverUrl: string
  readonly deviceKey?: string
}

export interface WecomTestInput {
  readonly webhookUrl?: string
}

export interface NtfyTestInput {
  readonly serverUrl: string
  readonly topic?: string
  readonly token?: string
}

/** One browser's subscription as the settings page lists it; the endpoint itself stays on the server. */
export interface PushSubscriptionView {
  readonly id: string
  readonly deviceId: ManagementDeviceId
  readonly deviceLabel: string
  readonly label: string
  readonly createdAt: number
  readonly lastDeliveredAt?: number
}

export interface PushSubscriptionInput {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly label: string
}

/** Login devices and their push subscriptions; revoking a device removes its subscriptions. */
export interface PushSubscriptionStore {
  getActiveDevice(id: ManagementDeviceId): ManagementDeviceRecord | undefined
  listDevices(): readonly ManagementDeviceRecord[]
  putPushSubscription(record: Omit<PushSubscriptionRecord, 'lastDeliveredAt'>): PushSubscriptionRecord
  listPushSubscriptions(): readonly PushSubscriptionRecord[]
  deletePushSubscriptions(endpoints: readonly string[]): number
  markPushDelivered(endpoint: string, deliveredAt: number): void
}

/** The part of `web-push` the service uses; tests replace it. */
export interface WebPushSender {
  generateVAPIDKeys(): { readonly publicKey: string; readonly privateKey: string }
  sendNotification(
    subscription: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } },
    payload: string,
    options: {
      readonly vapidDetails: { readonly subject: string; readonly publicKey: string; readonly privateKey: string }
      readonly TTL: number
      readonly timeout: number
      readonly topic?: string
    },
  ): Promise<unknown>
}

export interface DynamicApprovalNotification {
  readonly requestId: string
  readonly agentId: string
  /** The dynamic plugin being built; repeated candidates of it share one notification. */
  readonly pluginId: string
  readonly agentDisplayName: string
  readonly extensionName: string
  readonly purpose: string
}

interface NotificationSettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

type FetchLike = typeof fetch

const defaultSettings = (): StoredNotificationSettings => ({
  version: 1,
  system: { enabled: true },
  bark: { enabled: false, serverUrl: DEFAULT_BARK_SERVER_URL },
  browserPush: { enabled: true },
  wecom: { enabled: false },
  ntfy: { enabled: false, serverUrl: DEFAULT_NTFY_SERVER_URL },
  events: {
    [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true,
    [COMMUNITY_FEEDBACK_NOTIFICATION]: true,
    [CREDENTIAL_REQUEST_NOTIFICATION]: true,
    [EXTENSION_NOTIFICATION]: true,
  },
})

/**
 * One live notification per source: a client shows a newer notification with the same id in place of the older one.
 * Long parts are hashed so the id stays within the contract limit.
 */
const sourceId = (kind: string, ...parts: readonly string[]): string => {
  const id = [kind, ...parts].join(':')
  if (id.length <= 160) return id
  return `${kind}:${createHash('sha256').update(parts.join(':')).digest('hex')}`
}

/** Settings pages name a subscription by this instead of its endpoint, which works as a credential. */
export const pushSubscriptionId = (endpoint: string): string =>
  createHash('sha256').update(endpoint).digest('hex').slice(0, 32)

interface OutgoingNotification {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly route?: string
  /** Bark groups pushes with the same group together. */
  readonly barkGroup: string
}

const normalizeHttpUrl = (raw: string, name: string, options: { readonly allowQuery?: boolean } = {}): string => {
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${name}只支持 HTTP 或 HTTPS。`)
  }
  if (url.username || url.password || url.hash || (url.search && options.allowQuery !== true)) {
    throw new TypeError(
      options.allowQuery === true ? `${name}不能包含账号、密码或片段。` : `${name}不能包含账号、密码、查询参数或片段。`,
    )
  }
  return options.allowQuery === true ? url.toString() : url.toString().replace(/\/$/u, '')
}

const normalizeServerUrl = (raw: string): string => normalizeHttpUrl(raw, 'Bark 服务地址')

const normalizeDeviceKey = (raw: string): string => {
  const value = raw.trim()
  if (!value || value.length > 2048) throw new TypeError('Bark Device Key 长度无效。')
  return value
}

const normalizeWecomWebhook = (raw: string): string =>
  normalizeHttpUrl(raw, '企业微信 Webhook 地址', { allowQuery: true })

const normalizeNtfyServerUrl = (raw: string): string => normalizeHttpUrl(raw, 'ntfy 服务地址')

const normalizeNtfyTopic = (raw: string): string => {
  const value = raw.trim()
  if (!/^[-_A-Za-z0-9]{1,64}$/u.test(value))
    throw new TypeError('ntfy 主题只能包含字母、数字、- 和 _，最长 64 个字符。')
  return value
}

const normalizeNtfyToken = (raw: string): string => {
  const value = raw.trim()
  if (!value || value.length > 512) throw new TypeError('ntfy 访问令牌长度无效。')
  return value
}

/** Says why a channel could not be reached, without the address's secret parts. */
const describeFailure = (name: string, url: string, error: unknown): Error => {
  // Latin names get a space next to Chinese text.
  const before = /^[A-Za-z]/u.test(name) ? ` ${name}` : name
  const after = /[A-Za-z]$/u.test(name) ? `${name} ` : name
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new Error(`${after}超过 10 秒没有响应。`, { cause: error })
  }
  const code =
    error instanceof Error && error.cause instanceof Error && 'code' in error.cause ? String(error.cause.code) : ''
  const host = new URL(url).host
  if (error instanceof TypeError || code !== '') {
    return new Error(`连不上${before}（${host}${code ? `，${code}` : ''}）。这台服务器所在的网络可能访问不到它。`, {
      cause: error,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

const defaultWebPush: WebPushSender = {
  generateVAPIDKeys: () => webPush.generateVAPIDKeys(),
  sendNotification: (subscription, payload, options) =>
    webPush.sendNotification({ endpoint: subscription.endpoint, keys: { ...subscription.keys } }, payload, {
      vapidDetails: { ...options.vapidDetails },
      TTL: options.TTL,
      timeout: options.timeout,
      ...(options.topic === undefined ? {} : { topic: options.topic }),
    }),
}

const pushStatus = (error: unknown): number | undefined =>
  error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined

/** How long the same waiting candidate stays quiet after it was announced. */
const APPROVAL_REMINDER_MS = 60 * 60 * 1000

/**
 * Notification channels and the client feed. Each channel delivers on its own: one failing never keeps the others
 * from sending.
 */
export class NotificationService {
  readonly #repository: NotificationSettingsRepository
  readonly #credentials: LocalCredentialStore
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #pushSubscriptions: PushSubscriptionStore | undefined
  readonly #webPush: WebPushSender
  readonly #redact: (text: string) => string
  readonly #publicOrigin: () => string | undefined
  readonly #clientNotifications: Array<{
    readonly cursor: number
    readonly notification: ClientNotification
    readonly event?: NotificationEventKey
  }> = []
  /** When each agent's candidate last asked to run; the runner may ask again for a candidate still waiting. */
  readonly #approvalNotifiedAt = new Map<string, number>()
  #notificationCursor = 0
  /** Names this run; cursors restart at zero with every run. */
  readonly #bootId = randomBytes(9).toString('base64url')
  readonly #notificationWaiters = new Set<() => void>()
  #webPushKeys: Promise<{ readonly publicKey: string; readonly privateKey: string }> | undefined

  constructor(
    repository: NotificationSettingsRepository,
    credentials: LocalCredentialStore,
    options: {
      readonly fetch?: FetchLike
      readonly now?: () => number
      /** Without it the instance has no login devices, so browser push is off. */
      readonly pushSubscriptions?: PushSubscriptionStore
      readonly webPush?: WebPushSender
      /** Hides known secrets in what leaves the instance. */
      readonly redact?: (text: string) => string
      /** The instance's access address; Bark, ntfy and WeCom messages link to the notification's page there. */
      readonly publicOrigin?: () => string | undefined
    } = {},
  ) {
    this.#repository = repository
    this.#credentials = credentials
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#pushSubscriptions = options.pushSubscriptions
    this.#webPush = options.webPush ?? defaultWebPush
    this.#redact = options.redact ?? ((text) => text)
    this.#publicOrigin = options.publicOrigin ?? (() => undefined)
  }

  async getSettings(): Promise<NotificationSettingsView> {
    const record = this.#readRecord()
    const settings = record?.settings ?? defaultSettings()
    const has = (reference: string | undefined) =>
      reference === undefined ? Promise.resolve(false) : this.#credentials.has(reference)
    return {
      ...(record === undefined ? {} : { revision: record.revision }),
      system: settings.system,
      bark: {
        enabled: settings.bark.enabled,
        serverUrl: settings.bark.serverUrl,
        deviceKeyConfigured: await has(settings.bark.credentialRef),
      },
      browserPush: settings.browserPush,
      wecom: { enabled: settings.wecom.enabled, webhookConfigured: await has(settings.wecom.credentialRef) },
      ntfy: {
        enabled: settings.ntfy.enabled,
        serverUrl: settings.ntfy.serverUrl,
        topicConfigured: await has(settings.ntfy.topicRef),
        tokenConfigured: await has(settings.ntfy.tokenRef),
      },
      events: settings.events,
    }
  }

  async updateSettings(input: NotificationSettingsUpdate): Promise<NotificationSettingsView> {
    if (input.bark.deviceKey !== undefined && input.bark.clearDeviceKey === true) {
      throw new TypeError('不能同时更新并清除 Bark Device Key。')
    }
    if (input.wecom?.webhookUrl !== undefined && input.wecom.clearWebhookUrl === true) {
      throw new TypeError('不能同时更新并清除企业微信 Webhook 地址。')
    }
    if (input.ntfy?.token !== undefined && input.ntfy.clearToken === true) {
      throw new TypeError('不能同时更新并清除 ntfy 访问令牌。')
    }
    const currentRecord = this.#readRecord()
    const current = currentRecord?.settings ?? defaultSettings()
    // Secrets saved by this update; they are removed again if the update fails.
    const created: string[] = []
    const replaceSecret = async (
      reference: string | undefined,
      value: string | undefined,
      clear: boolean | undefined,
    ): Promise<string | undefined> => {
      if (value !== undefined) {
        const saved = await this.#credentials.save(value)
        created.push(saved)
        return saved
      }
      return clear === true ? undefined : reference
    }
    let next: StoredNotificationSettings
    try {
      const barkRef = await replaceSecret(
        current.bark.credentialRef,
        input.bark.deviceKey === undefined ? undefined : normalizeDeviceKey(input.bark.deviceKey),
        input.bark.clearDeviceKey,
      )
      if (input.bark.enabled && barkRef === undefined) throw new Error('请先填写 Bark Device Key，再启用通知渠道。')
      const wecomRef = await replaceSecret(
        current.wecom.credentialRef,
        input.wecom?.webhookUrl === undefined ? undefined : normalizeWecomWebhook(input.wecom.webhookUrl),
        input.wecom?.clearWebhookUrl,
      )
      const wecomEnabled = input.wecom?.enabled ?? current.wecom.enabled
      if (wecomEnabled && wecomRef === undefined) throw new Error('请先填写企业微信 Webhook 地址，再启用通知渠道。')
      const topicRef = await replaceSecret(
        current.ntfy.topicRef,
        input.ntfy?.topic === undefined ? undefined : normalizeNtfyTopic(input.ntfy.topic),
        undefined,
      )
      const tokenRef = await replaceSecret(
        current.ntfy.tokenRef,
        input.ntfy?.token === undefined ? undefined : normalizeNtfyToken(input.ntfy.token),
        input.ntfy?.clearToken,
      )
      const ntfyEnabled = input.ntfy?.enabled ?? current.ntfy.enabled
      if (ntfyEnabled && topicRef === undefined) throw new Error('请先填写 ntfy 主题，再启用通知渠道。')
      next = {
        version: 1,
        system: { enabled: input.system.enabled },
        bark: {
          enabled: input.bark.enabled,
          serverUrl: normalizeServerUrl(input.bark.serverUrl),
          ...(barkRef === undefined ? {} : { credentialRef: barkRef }),
        },
        browserPush: { enabled: input.browserPush?.enabled ?? current.browserPush.enabled },
        wecom: { enabled: wecomEnabled, ...(wecomRef === undefined ? {} : { credentialRef: wecomRef }) },
        ntfy: {
          enabled: ntfyEnabled,
          serverUrl: input.ntfy === undefined ? current.ntfy.serverUrl : normalizeNtfyServerUrl(input.ntfy.serverUrl),
          ...(topicRef === undefined ? {} : { topicRef }),
          ...(tokenRef === undefined ? {} : { tokenRef }),
        },
        events: {
          [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: input.events[DYNAMIC_CLIENT_APPROVAL_NOTIFICATION],
          [COMMUNITY_FEEDBACK_NOTIFICATION]:
            input.events[COMMUNITY_FEEDBACK_NOTIFICATION] ?? current.events[COMMUNITY_FEEDBACK_NOTIFICATION],
          [CREDENTIAL_REQUEST_NOTIFICATION]:
            input.events[CREDENTIAL_REQUEST_NOTIFICATION] ?? current.events[CREDENTIAL_REQUEST_NOTIFICATION],
          [EXTENSION_NOTIFICATION]: input.events[EXTENSION_NOTIFICATION] ?? current.events[EXTENSION_NOTIFICATION],
        },
      }
      this.#repository.putSystemSetting(
        NOTIFICATION_SETTING_KEY,
        JsonValueSchema.parse(next),
        input.expectedRevision,
        this.#now(),
      )
    } catch (error) {
      for (const reference of created) await this.#credentials.delete(reference)
      throw error
    }
    const kept = new Set([next.bark.credentialRef, next.wecom.credentialRef, next.ntfy.topicRef, next.ntfy.tokenRef])
    for (const reference of [
      current.bark.credentialRef,
      current.wecom.credentialRef,
      current.ntfy.topicRef,
      current.ntfy.tokenRef,
    ]) {
      if (reference !== undefined && !kept.has(reference)) await this.#credentials.delete(reference)
    }
    return await this.getSettings()
  }

  async testBark(input: BarkTestInput): Promise<void> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const deviceKey =
      input.deviceKey === undefined
        ? await this.#resolveOptional(stored.bark.credentialRef)
        : normalizeDeviceKey(input.deviceKey)
    if (deviceKey === undefined) throw new Error('请先填写 Bark Device Key。')
    await this.#sendBark(serverUrl, deviceKey, {
      title: 'NekroNXT 测试通知',
      body: 'Bark 通知渠道已连接。',
    })
  }

  async testWecom(input: WecomTestInput): Promise<void> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    const webhookUrl =
      input.webhookUrl === undefined
        ? await this.#resolveOptional(stored.wecom.credentialRef)
        : normalizeWecomWebhook(input.webhookUrl)
    if (webhookUrl === undefined) throw new Error('请先填写企业微信 Webhook 地址。')
    await this.#sendWecom(webhookUrl, { title: 'NekroNXT 测试通知', body: '企业微信通知渠道已连接。' })
  }

  async testNtfy(input: NtfyTestInput): Promise<void> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    const topic =
      input.topic === undefined ? await this.#resolveOptional(stored.ntfy.topicRef) : normalizeNtfyTopic(input.topic)
    if (topic === undefined) throw new Error('请先填写 ntfy 主题。')
    const token =
      input.token === undefined ? await this.#resolveOptional(stored.ntfy.tokenRef) : normalizeNtfyToken(input.token)
    await this.#sendNtfy(normalizeNtfyServerUrl(input.serverUrl), topic, token, {
      title: 'NekroNXT 测试通知',
      body: 'ntfy 通知渠道已连接。',
    })
  }

  /** The public VAPID key browsers subscribe with; the key pair is made the first time anyone asks. */
  async webPushPublicKey(): Promise<string> {
    return (await this.#loadWebPushKeys()).publicKey
  }

  listPushSubscriptions(): readonly PushSubscriptionView[] {
    const store = this.#requirePushStore()
    const labels = new Map(store.listDevices().map((device) => [device.id, device.label]))
    return store.listPushSubscriptions().map((entry) => ({
      id: pushSubscriptionId(entry.endpoint),
      deviceId: entry.deviceId,
      deviceLabel: labels.get(entry.deviceId) ?? entry.deviceId,
      label: entry.label,
      createdAt: entry.createdAt,
      ...(entry.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: entry.lastDeliveredAt }),
    }))
  }

  /** Registers the browser of a login device; the same browser subscribing again replaces its row. */
  registerPushSubscription(deviceId: ManagementDeviceId, input: PushSubscriptionInput): PushSubscriptionView {
    const store = this.#requirePushStore()
    const device = store.getActiveDevice(deviceId)
    if (device === undefined) throw new Error('这台设备已经退出登录。')
    const endpoint = new URL(input.endpoint)
    if (endpoint.protocol !== 'https:') throw new TypeError('推送地址必须是 HTTPS。')
    const record = store.putPushSubscription({
      endpoint: endpoint.toString(),
      deviceId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: input.label.trim().slice(0, 80) || '浏览器',
      createdAt: this.#now(),
    })
    return {
      id: pushSubscriptionId(record.endpoint),
      deviceId,
      deviceLabel: device.label,
      label: record.label,
      createdAt: record.createdAt,
      ...(record.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: record.lastDeliveredAt }),
    }
  }

  removePushSubscription(id: string): boolean {
    const store = this.#requirePushStore()
    const found = store.listPushSubscriptions().find((entry) => pushSubscriptionId(entry.endpoint) === id)
    return found === undefined ? false : store.deletePushSubscriptions([found.endpoint]) > 0
  }

  /** Sends a test to one subscription and explains why it failed; a subscription the browser gave up is removed. */
  async testPushSubscription(id: string): Promise<void> {
    const store = this.#requirePushStore()
    const found = store.listPushSubscriptions().find((entry) => pushSubscriptionId(entry.endpoint) === id)
    if (found === undefined) throw new Error('这个订阅已经不存在。')
    const result = await this.#sendPush(found, {
      id: 'push-test',
      title: 'NekroNXT 测试通知',
      body: '浏览器推送已连接。',
      route: '/settings/notifications',
    })
    if (result === 'gone') throw new Error('这个订阅已经失效，已移除。请在那台设备上重新开启推送。')
  }

  /**
   * Tells the admin a candidate waits for permission to run. One candidate asks once per hour at most (#91): the
   * runner asks again on every retry, and each push would otherwise stack another notification.
   */
  async notifyDynamicApproval(input: DynamicApprovalNotification): Promise<'sent' | 'skipped'> {
    const key = `${input.agentId}:${input.pluginId}`
    const last = this.#approvalNotifiedAt.get(key)
    if (last !== undefined && this.#now() - last < APPROVAL_REMINDER_MS) return 'skipped'
    const result = await this.#deliver(DYNAMIC_CLIENT_APPROVAL_NOTIFICATION, {
      id: sourceId('dynamic-approval', input.agentId, input.pluginId),
      title: '有扩展等你试运行',
      body: `「${input.agentDisplayName}」做的「${input.extensionName}」需要你允许运行。${input.purpose ? `用途：${input.purpose}` : ''}`,
      route: '/workshop',
      barkGroup: `NekroNXT · ${input.extensionName}`,
    })
    if (result === 'sent') this.#approvalNotifiedAt.set(key, this.#now())
    return result
  }

  /** An agent asked for a credential; the link opens the add form pre-filled. */
  async notifyCredentialRequest(input: {
    readonly requestId: string
    readonly agentDisplayName: string
    readonly name: string
    readonly purpose: string
    readonly route: string
  }): Promise<'sent' | 'skipped'> {
    return await this.#deliver(CREDENTIAL_REQUEST_NOTIFICATION, {
      id: sourceId('credential-request', input.requestId),
      title: '智能体需要凭据',
      body: `「${input.agentDisplayName}」需要凭据「${input.name}」。${input.purpose ? `用途：${input.purpose}` : ''}`,
      route: input.route,
      barkGroup: 'NekroNXT · 凭据申请',
    })
  }

  async notifyCommunityFeedback(input: {
    readonly kind: 'draft' | 'update'
    readonly ref?: string
  }): Promise<'sent' | 'skipped'> {
    return await this.#deliver(COMMUNITY_FEEDBACK_NOTIFICATION, {
      id: sourceId('feedback', input.ref ?? 'draft'),
      title: input.kind === 'draft' ? '有反馈等你确认' : '社区反馈有更新',
      body: input.kind === 'draft' ? '可以在社区反馈页查看并发送。' : `反馈 ${input.ref ?? ''} 有了新进展。`,
      route: '/community/feedback',
      barkGroup: 'NekroNXT · 社区反馈',
    })
  }

  publishSystemTest(): void {
    this.#publishClientNotification({
      id: 'system-test',
      kind: 'action-required',
      title: 'NekroNXT 测试通知',
      body: '系统通知渠道已连接。',
      occurredAt: this.#now(),
      route: '/settings',
    })
  }

  /**
   * A notification an extension page published. Invalid input throws right away; delivery runs afterwards, so a
   * failing Bark push never reaches the extension.
   */
  publishExtensionNotification(input: {
    readonly owner: string
    /** Shown as the Bark group; usually the extension page title. */
    readonly sourceName?: string
    readonly title: string
    readonly body: string
    readonly route?: string
  }): Promise<'sent' | 'skipped'> {
    const title = z.string().trim().min(1).max(80).parse(input.title)
    const body = z.string().trim().min(1).max(240).parse(input.body)
    const route =
      input.route === undefined
        ? undefined
        : z
            .string()
            .regex(/^\/(?!\/)[a-z0-9/_?=&.-]*$/u)
            .parse(input.route)
    return this.#deliver(EXTENSION_NOTIFICATION, {
      id: sourceId('notice', input.owner),
      title,
      body,
      ...(route === undefined ? {} : { route }),
      barkGroup: `NekroNXT · ${input.sourceName?.trim() || '扩展'}`,
    })
  }

  /**
   * Notifications after `cursor`. A cursor from an earlier run (another `boot`, or past the current count) gets the
   * current baseline instead, so a client that outlived a restart does not wait for numbers it already saw.
   */
  readClientNotifications(
    cursor: number | undefined,
    boot?: string,
    withEvents = false,
  ): {
    readonly cursor: number
    readonly notifications: readonly ClientNotification[]
    readonly bootId?: string
  } {
    const current = cursor === undefined || this.#staleCursor(cursor, boot) ? undefined : cursor
    return {
      cursor: this.#notificationCursor,
      notifications:
        current === undefined
          ? []
          : this.#clientNotifications
              .filter((entry) => entry.cursor > current)
              .map((entry) =>
                withEvents && entry.event !== undefined
                  ? { ...entry.notification, event: entry.event }
                  : entry.notification,
              ),
      ...(boot === undefined ? {} : { bootId: this.#bootId }),
    }
  }

  /** Like `readClientNotifications`, but holds on for up to `waitMs` while nothing is new after a valid cursor. */
  async waitClientNotifications(input: {
    readonly cursor?: number
    readonly boot?: string
    readonly waitMs: number
    readonly signal?: AbortSignal
    readonly withEvents?: boolean
  }): Promise<ReturnType<NotificationService['readClientNotifications']>> {
    const feed = this.readClientNotifications(input.cursor, input.boot, input.withEvents)
    if (
      input.waitMs <= 0 ||
      input.cursor === undefined ||
      feed.notifications.length > 0 ||
      this.#staleCursor(input.cursor, input.boot) ||
      input.signal?.aborted === true
    ) {
      return feed
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.#notificationWaiters.delete(done)
        input.signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, input.waitMs)
      this.#notificationWaiters.add(done)
      input.signal?.addEventListener('abort', done, { once: true })
    })
    return this.readClientNotifications(input.cursor, input.boot, input.withEvents)
  }

  #staleCursor(cursor: number, boot: string | undefined): boolean {
    return cursor > this.#notificationCursor || (boot !== undefined && boot !== this.#bootId)
  }

  async #deliver(event: NotificationEventKey, notification: OutgoingNotification): Promise<'sent' | 'skipped'> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    if (!stored.events[event]) return 'skipped'
    const message = {
      ...notification,
      title: this.#redact(notification.title),
      body: [...this.#redact(notification.body)].slice(0, 240).join(''),
    }
    const origin = this.#publicOrigin()
    const link = origin === undefined || message.route === undefined ? undefined : new URL(message.route, origin).href
    const linked = { ...message, ...(link === undefined ? {} : { link }) }
    const channels: Array<readonly [string, () => Promise<void>]> = []
    if (stored.system.enabled) {
      this.#publishClientNotification(
        {
          id: message.id,
          kind: 'action-required',
          title: message.title,
          body: message.body,
          occurredAt: this.#now(),
          ...(message.route === undefined ? {} : { route: message.route }),
        },
        event,
      )
    }
    if (stored.bark.enabled && stored.bark.credentialRef !== undefined) {
      const reference = stored.bark.credentialRef
      channels.push([
        'Bark',
        async () =>
          await this.#sendBark(stored.bark.serverUrl, await this.#credentials.resolve(reference), {
            title: message.title,
            body: message.body,
            group: message.barkGroup,
            ...(link === undefined ? {} : { link }),
          }),
      ])
    }
    if (stored.wecom.enabled && stored.wecom.credentialRef !== undefined) {
      const reference = stored.wecom.credentialRef
      channels.push(['企业微信', async () => await this.#sendWecom(await this.#credentials.resolve(reference), linked)])
    }
    if (stored.ntfy.enabled && stored.ntfy.topicRef !== undefined) {
      const { serverUrl, topicRef, tokenRef } = stored.ntfy
      channels.push([
        'ntfy',
        async () =>
          await this.#sendNtfy(
            serverUrl,
            await this.#credentials.resolve(topicRef),
            await this.#resolveOptional(tokenRef),
            linked,
          ),
      ])
    }
    const subscriptions =
      stored.browserPush.enabled && this.#pushSubscriptions !== undefined
        ? this.#pushSubscriptions.listPushSubscriptions()
        : []
    for (const subscription of subscriptions) {
      channels.push(['浏览器推送', async () => void (await this.#sendPush(subscription, message))])
    }
    const results = await Promise.allSettled(channels.map(([, send]) => send()))
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[nekro-nxt] ${channels[index]![0]} 通知没有发出：`, result.reason)
      }
    })
    return stored.system.enabled || results.some((result) => result.status === 'fulfilled') ? 'sent' : 'skipped'
  }

  #readRecord(): { readonly settings: StoredNotificationSettings; readonly revision: number } | undefined {
    const record = this.#repository.getSystemSetting(NOTIFICATION_SETTING_KEY)
    if (record === undefined) return undefined
    return { settings: StoredNotificationSettingsSchema.parse(record.value), revision: record.revision }
  }

  async #resolveOptional(reference: string | undefined): Promise<string | undefined> {
    return reference === undefined ? undefined : await this.#credentials.resolve(reference)
  }

  #publishClientNotification(input: ClientNotification, event?: NotificationEventKey): void {
    const notification = ClientNotificationSchema.parse(input)
    this.#notificationCursor += 1
    this.#clientNotifications.push({
      cursor: this.#notificationCursor,
      notification,
      ...(event === undefined ? {} : { event }),
    })
    if (this.#clientNotifications.length > 128) this.#clientNotifications.shift()
    for (const wake of [...this.#notificationWaiters]) wake()
  }

  #requirePushStore(): PushSubscriptionStore {
    if (this.#pushSubscriptions === undefined) throw new Error('这个实例没有登录设备，不能使用浏览器推送。')
    return this.#pushSubscriptions
  }

  #loadWebPushKeys(): Promise<{ readonly publicKey: string; readonly privateKey: string }> {
    this.#webPushKeys ??= (async () => {
      const record = this.#repository.getSystemSetting(WEB_PUSH_KEYS_SETTING_KEY)
      if (record !== undefined) {
        const stored = StoredWebPushKeysSchema.parse(record.value)
        return { publicKey: stored.publicKey, privateKey: await this.#credentials.resolve(stored.privateKeyRef) }
      }
      const keys = this.#webPush.generateVAPIDKeys()
      const privateKeyRef = await this.#credentials.save(keys.privateKey)
      try {
        this.#repository.putSystemSetting(
          WEB_PUSH_KEYS_SETTING_KEY,
          JsonValueSchema.parse({ version: 1, publicKey: keys.publicKey, privateKeyRef }),
          undefined,
          this.#now(),
        )
      } catch (error) {
        await this.#credentials.delete(privateKeyRef)
        throw error
      }
      return { publicKey: keys.publicKey, privateKey: keys.privateKey }
    })()
    // A failed attempt is not remembered, so the next request tries again.
    this.#webPushKeys.catch(() => {
      this.#webPushKeys = undefined
    })
    return this.#webPushKeys
  }

  /**
   * One push to one browser. The payload carries only what the notification shows and where a click leads; the
   * push service answering 404 or 410 means the browser dropped the subscription, so it is removed here too.
   */
  async #sendPush(
    subscription: PushSubscriptionRecord,
    message: Pick<OutgoingNotification, 'id' | 'title' | 'body' | 'route'>,
  ): Promise<'delivered' | 'gone'> {
    const keys = await this.#loadWebPushKeys()
    const store = this.#requirePushStore()
    try {
      await this.#webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify({
          title: message.title,
          body: message.body,
          route: message.route ?? '/',
          tag: message.id,
        }),
        {
          vapidDetails: { subject: WEB_PUSH_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: WEB_PUSH_TTL_SECONDS,
          timeout: CHANNEL_TIMEOUT_MS,
        },
      )
    } catch (error) {
      const status = pushStatus(error)
      if (status === 404 || status === 410) {
        store.deletePushSubscriptions([subscription.endpoint])
        return 'gone'
      }
      if (status !== undefined) throw new Error(`推送服务返回 HTTP ${status}。`, { cause: error })
      throw describeFailure('推送服务', subscription.endpoint, error)
    }
    store.markPushDelivered(subscription.endpoint, this.#now())
    return 'delivered'
  }

  async #post(name: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS) })
    } catch (error) {
      throw describeFailure(name, url, error)
    }
  }

  async #sendBark(
    serverUrl: string,
    deviceKey: string,
    message: { readonly title: string; readonly body: string; readonly group?: string; readonly link?: string },
  ): Promise<void> {
    const response = await this.#post('Bark', `${normalizeServerUrl(serverUrl)}/push`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_key: deviceKey,
        title: message.title,
        body: message.body,
        group: message.group ?? 'NekroNXT',
        ...(message.link === undefined ? {} : { url: message.link }),
      }),
    })
    if (!response.ok) throw new Error(`Bark 返回 HTTP ${response.status}。`)
  }

  async #sendWecom(
    webhookUrl: string,
    message: { readonly title: string; readonly body: string; readonly link?: string },
  ): Promise<void> {
    const response = await this.#post('企业微信', webhookUrl, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: {
          content: [message.title, message.body, ...(message.link === undefined ? [] : [message.link])].join('\n'),
        },
      }),
    })
    if (!response.ok) throw new Error(`企业微信返回 HTTP ${response.status}。`)
    // The robot answers 200 with an error code when the key is wrong or the robot was removed.
    const result = z
      .object({ errcode: z.number(), errmsg: z.string().optional() })
      .safeParse(await response.json().catch(() => undefined))
    if (result.success && result.data.errcode !== 0) {
      throw new Error(
        `企业微信拒绝了这条消息（${result.data.errcode}${result.data.errmsg ? `：${result.data.errmsg}` : ''}）。`,
      )
    }
  }

  async #sendNtfy(
    serverUrl: string,
    topic: string,
    token: string | undefined,
    message: { readonly title: string; readonly body: string; readonly link?: string },
  ): Promise<void> {
    const response = await this.#post('ntfy', serverUrl, {
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        topic,
        title: message.title,
        message: message.body,
        ...(message.link === undefined ? {} : { click: message.link }),
      }),
    })
    if (response.status === 401 || response.status === 403) throw new Error('ntfy 拒绝了访问，请检查访问令牌。')
    if (!response.ok) throw new Error(`ntfy 返回 HTTP ${response.status}。`)
  }
}
