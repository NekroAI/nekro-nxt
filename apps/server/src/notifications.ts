import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ClientNotificationSchema,
  JsonValueSchema,
  type ClientNotification,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
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
const DEFAULT_BARK_SERVER_URL = 'https://api.day.app'

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

export interface NotificationSettingsView {
  readonly revision?: number
  readonly system: { readonly enabled: boolean }
  readonly bark: {
    readonly enabled: boolean
    readonly serverUrl: string
    readonly deviceKeyConfigured: boolean
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

interface OutgoingNotification {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly route?: string
  /** Bark groups pushes with the same group together. */
  readonly barkGroup: string
}

const normalizeServerUrl = (raw: string): string => {
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Bark 服务地址只支持 HTTP 或 HTTPS。')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Bark 服务地址不能包含账号、密码、查询参数或片段。')
  }
  return url.toString().replace(/\/$/u, '')
}

const normalizeDeviceKey = (raw: string): string => {
  const value = raw.trim()
  if (!value || value.length > 2048) throw new TypeError('Bark Device Key 长度无效。')
  return value
}

export class NotificationService {
  readonly #repository: NotificationSettingsRepository
  readonly #credentials: LocalCredentialStore
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #clientNotifications: Array<{ readonly cursor: number; readonly notification: ClientNotification }> = []
  #notificationCursor = 0

  constructor(
    repository: NotificationSettingsRepository,
    credentials: LocalCredentialStore,
    options: { readonly fetch?: FetchLike; readonly now?: () => number } = {},
  ) {
    this.#repository = repository
    this.#credentials = credentials
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  async getSettings(): Promise<NotificationSettingsView> {
    const record = this.#readRecord()
    const settings = record?.settings ?? defaultSettings()
    const deviceKeyConfigured =
      settings.bark.credentialRef === undefined ? false : await this.#credentials.has(settings.bark.credentialRef)
    return {
      ...(record === undefined ? {} : { revision: record.revision }),
      system: settings.system,
      bark: {
        enabled: settings.bark.enabled,
        serverUrl: settings.bark.serverUrl,
        deviceKeyConfigured,
      },
      events: settings.events,
    }
  }

  async updateSettings(input: NotificationSettingsUpdate): Promise<NotificationSettingsView> {
    if (input.bark.deviceKey !== undefined && input.bark.clearDeviceKey === true) {
      throw new TypeError('不能同时更新并清除 Bark Device Key。')
    }
    const currentRecord = this.#readRecord()
    const current = currentRecord?.settings ?? defaultSettings()
    const serverUrl = normalizeServerUrl(input.bark.serverUrl)
    let nextCredentialRef = current.bark.credentialRef
    let createdCredentialRef: string | undefined
    if (input.bark.deviceKey !== undefined) {
      createdCredentialRef = await this.#credentials.save(normalizeDeviceKey(input.bark.deviceKey))
      nextCredentialRef = createdCredentialRef
    } else if (input.bark.clearDeviceKey === true) {
      nextCredentialRef = undefined
    }
    if (input.bark.enabled && nextCredentialRef === undefined) {
      if (createdCredentialRef !== undefined) await this.#credentials.delete(createdCredentialRef)
      throw new Error('请先填写 Bark Device Key，再启用通知渠道。')
    }
    const next: StoredNotificationSettings = {
      version: 1,
      system: { enabled: input.system.enabled },
      bark: {
        enabled: input.bark.enabled,
        serverUrl,
        ...(nextCredentialRef === undefined ? {} : { credentialRef: nextCredentialRef }),
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
    try {
      this.#repository.putSystemSetting(
        NOTIFICATION_SETTING_KEY,
        JsonValueSchema.parse(next),
        input.expectedRevision,
        this.#now(),
      )
    } catch (error) {
      if (createdCredentialRef !== undefined) await this.#credentials.delete(createdCredentialRef)
      throw error
    }
    if (current.bark.credentialRef !== undefined && current.bark.credentialRef !== nextCredentialRef) {
      await this.#credentials.delete(current.bark.credentialRef)
    }
    return await this.getSettings()
  }

  async testBark(input: BarkTestInput): Promise<void> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const deviceKey =
      input.deviceKey === undefined
        ? stored.bark.credentialRef === undefined
          ? undefined
          : await this.#credentials.resolve(stored.bark.credentialRef)
        : normalizeDeviceKey(input.deviceKey)
    if (deviceKey === undefined) throw new Error('请先填写 Bark Device Key。')
    await this.#sendBark(serverUrl, deviceKey, {
      title: 'NekroNXT 测试通知',
      body: 'Bark 通知渠道已连接。',
    })
  }

  async notifyDynamicApproval(input: DynamicApprovalNotification): Promise<'sent' | 'skipped'> {
    return await this.#deliver(DYNAMIC_CLIENT_APPROVAL_NOTIFICATION, {
      id: sourceId('dynamic-approval', input.agentId, input.pluginId),
      title: '有扩展等你试运行',
      body: `「${input.agentDisplayName}」做的「${input.extensionName}」需要你允许运行。${input.purpose ? `用途：${input.purpose}` : ''}`,
      route: '/workshop',
      barkGroup: `NekroNXT · ${input.extensionName}`,
    })
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

  readClientNotifications(cursor: number | undefined): {
    readonly cursor: number
    readonly notifications: readonly ClientNotification[]
  } {
    if (cursor === undefined) return { cursor: this.#notificationCursor, notifications: [] }
    return {
      cursor: this.#notificationCursor,
      notifications: this.#clientNotifications
        .filter((entry) => entry.cursor > cursor)
        .map((entry) => entry.notification),
    }
  }

  async #deliver(event: NotificationEventKey, notification: OutgoingNotification): Promise<'sent' | 'skipped'> {
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    if (!stored.events[event]) return 'skipped'
    let sent = false
    if (stored.system.enabled) {
      this.#publishClientNotification({
        id: notification.id,
        kind: 'action-required',
        title: notification.title,
        body: [...notification.body].slice(0, 240).join(''),
        occurredAt: this.#now(),
        ...(notification.route === undefined ? {} : { route: notification.route }),
      })
      sent = true
    }
    if (stored.bark.enabled && stored.bark.credentialRef !== undefined) {
      await this.#sendBark(stored.bark.serverUrl, await this.#credentials.resolve(stored.bark.credentialRef), {
        title: notification.title,
        body: notification.body,
        group: notification.barkGroup,
      })
      sent = true
    }
    return sent ? 'sent' : 'skipped'
  }

  #readRecord(): { readonly settings: StoredNotificationSettings; readonly revision: number } | undefined {
    const record = this.#repository.getSystemSetting(NOTIFICATION_SETTING_KEY)
    if (record === undefined) return undefined
    return { settings: StoredNotificationSettingsSchema.parse(record.value), revision: record.revision }
  }

  #publishClientNotification(input: ClientNotification): void {
    const notification = ClientNotificationSchema.parse(input)
    this.#notificationCursor += 1
    this.#clientNotifications.push({ cursor: this.#notificationCursor, notification })
    if (this.#clientNotifications.length > 128) this.#clientNotifications.shift()
  }

  async #sendBark(
    serverUrl: string,
    deviceKey: string,
    message: { readonly title: string; readonly body: string; readonly group?: string },
  ): Promise<void> {
    const response = await this.#fetch(`${normalizeServerUrl(serverUrl)}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_key: deviceKey,
        title: message.title,
        body: message.body,
        group: message.group ?? 'NekroNXT',
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Bark 返回 HTTP ${response.status}。`)
  }
}
