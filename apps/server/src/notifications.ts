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
export type NotificationEventKey = typeof DYNAMIC_CLIENT_APPROVAL_NOTIFICATION

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
  readonly events: Readonly<Record<NotificationEventKey, boolean>>
}

export interface BarkTestInput {
  readonly serverUrl: string
  readonly deviceKey?: string
}

export interface DynamicApprovalNotification {
  readonly requestId: string
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
  events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
})

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
    const stored = this.#readRecord()?.settings ?? defaultSettings()
    if (!stored.events[DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]) return 'skipped'
    const title = '扩展预览等待确认'
    const body = `智能体「${input.agentDisplayName}」生成的扩展「${input.extensionName}」正在等待界面预览确认。${input.purpose ? ` 用途：${input.purpose}` : ''}`
    let sent = false
    if (stored.system.enabled) {
      this.#publishClientNotification({
        id: `dynamic-approval:${input.requestId}`,
        kind: 'action-required',
        title,
        body: [...body].slice(0, 240).join(''),
        occurredAt: this.#now(),
        route: '/work/creator',
      })
      sent = true
    }
    if (stored.bark.enabled && stored.bark.credentialRef !== undefined) {
      const deviceKey = await this.#credentials.resolve(stored.bark.credentialRef)
      await this.#sendBark(stored.bark.serverUrl, deviceKey, { title, body })
      sent = true
    }
    return sent ? 'sent' : 'skipped'
  }

  publishSystemTest(): void {
    this.#publishClientNotification({
      id: `system-test:${this.#now()}:${this.#notificationCursor + 1}`,
      kind: 'action-required',
      title: 'NekroNXT 测试通知',
      body: '系统通知渠道已连接。',
      occurredAt: this.#now(),
      route: '/settings',
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
    message: { readonly title: string; readonly body: string },
  ): Promise<void> {
    const response = await this.#fetch(`${normalizeServerUrl(serverUrl)}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_key: deviceKey,
        title: message.title,
        body: message.body,
        group: 'NekroNXT',
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Bark 返回 HTTP ${response.status}。`)
  }
}
