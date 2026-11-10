import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementDeviceIdSchema, type JsonValue } from '@nekro-nxt/contracts'
import type { ManagementDeviceRecord, PushSubscriptionRecord, SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { LocalCredentialStore } from '../src/credentials.js'
import {
  COMMUNITY_FEEDBACK_NOTIFICATION,
  CREDENTIAL_REQUEST_NOTIFICATION,
  DYNAMIC_CLIENT_APPROVAL_NOTIFICATION,
  EXTENSION_NOTIFICATION,
  NotificationService,
  pushSubscriptionId,
  type PushSubscriptionStore,
  type WebPushSender,
} from '../src/notifications.js'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const deviceA = ManagementDeviceIdSchema.parse('nxt_device_01J00000000000000000000AAA')
const deviceB = ManagementDeviceIdSchema.parse('nxt_device_01J00000000000000000000BBB')

/** Login devices and subscriptions kept in memory, with revocation removing a device's rows like the database. */
const createPushStore = () => {
  const devices = new Map<string, ManagementDeviceRecord>([
    [deviceA, { id: deviceA, label: '浏览器 · Safari · iOS', secretDigest: 'digest', createdAt: 1 }],
    [deviceB, { id: deviceB, label: '浏览器 · Chrome · macOS', secretDigest: 'digest', createdAt: 1 }],
  ])
  const rows = new Map<string, PushSubscriptionRecord>()
  const store: PushSubscriptionStore & { revoke(id: string): void } = {
    getActiveDevice: (id) => devices.get(id),
    listDevices: () => [...devices.values()],
    putPushSubscription: (record) => {
      const next = { ...rows.get(record.endpoint), ...record }
      rows.set(record.endpoint, next)
      return next
    },
    listPushSubscriptions: () => [...rows.values()].filter((row) => devices.has(row.deviceId)),
    deletePushSubscriptions: (endpoints) => endpoints.filter((endpoint) => rows.delete(endpoint)).length,
    markPushDelivered: (endpoint, at) => {
      const row = rows.get(endpoint)
      if (row !== undefined) rows.set(endpoint, { ...row, lastDeliveredAt: at })
    },
    revoke: (id) => {
      devices.delete(id)
      for (const [endpoint, row] of rows) if (row.deviceId === id) rows.delete(endpoint)
    },
  }
  return store
}

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined

const createWebPush = () => {
  const generateVAPIDKeys = vi.fn(() => ({ publicKey: 'synthetic-public-key', privateKey: 'synthetic-private-key' }))
  const sent: Array<{ readonly endpoint: string; readonly payload: unknown }> = []
  let failure: ((endpoint: string) => unknown) | undefined
  const sender: WebPushSender = {
    generateVAPIDKeys,
    sendNotification: (subscription, payload) => {
      const error = failure?.(subscription.endpoint)
      if (error !== undefined) return Promise.reject(error instanceof Error ? error : new Error('push failed'))
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as unknown })
      return Promise.resolve({ statusCode: 201 })
    },
  }
  return {
    sender,
    generateVAPIDKeys,
    sent,
    failWith: (next: ((endpoint: string) => unknown) | undefined) => {
      failure = next
    },
  }
}

const pushError = (statusCode: number) => Object.assign(new Error('push failed'), { statusCode })

const subscriptionInput = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'synthetic-p256dh', auth: 'synthetic-auth' },
  label: 'iPhone · 主屏幕',
})

const createFixture = async (
  options: {
    readonly now?: () => number
    readonly pushStore?: PushSubscriptionStore
    readonly webPush?: WebPushSender
    readonly redact?: (text: string) => string
    readonly publicOrigin?: string
  } = {},
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-notifications-'))
  temporaryRoots.push(root)
  const records = new Map<string, SystemSettingRecord>()
  const repository = {
    getSystemSetting: (key: string) => records.get(key),
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      const record = records.get(key)
      if (record?.revision !== expectedRevision || (record === undefined && expectedRevision !== undefined)) {
        throw new Error('System setting revision conflict.')
      }
      const next = { key, value, revision: (record?.revision ?? 0) + 1, updatedAt }
      records.set(key, next)
      return next
    },
  }
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 200 })))
  const credentials = new LocalCredentialStore(path.join(root, 'credentials'))
  const service = new NotificationService(repository, credentials, {
    fetch,
    now: options.now ?? (() => 1_725_000_000_000),
    ...(options.pushStore === undefined ? {} : { pushSubscriptions: options.pushStore }),
    ...(options.webPush === undefined ? {} : { webPush: options.webPush }),
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.publicOrigin === undefined ? {} : { publicOrigin: () => options.publicOrigin }),
  })
  return {
    service,
    fetch,
    repository,
    credentialFiles: async () => (await readdir(path.join(root, 'credentials')).catch(() => [])).length,
    record: {
      set: (value: JsonValue) => {
        const revision = (records.get('notifications')?.revision ?? 0) + 1
        records.set('notifications', { key: 'notifications', value, revision, updatedAt: 1 })
      },
    },
  }
}

const approval = {
  requestId: 'approval_synthetic',
  agentId: 'agent_synthetic',
  pluginId: 'plugin_synthetic',
  agentDisplayName: '资料员',
  extensionName: '文档复核',
  purpose: '检查遗漏',
}

describe('NotificationService', () => {
  it('routes feedback to its page and preserves a disabled event when an older client saves', async () => {
    const { service, fetch } = await createFixture()
    const cursor = service.readClientNotifications(undefined).cursor
    await expect(service.notifyCommunityFeedback({ kind: 'draft' })).resolves.toBe('sent')
    await expect(service.notifyCommunityFeedback({ kind: 'update', ref: 'FB-12' })).resolves.toBe('sent')
    expect(service.readClientNotifications(cursor).notifications.map((item) => item.route)).toEqual([
      '/community/feedback',
      '/community/feedback',
    ])
    expect(fetch).not.toHaveBeenCalled()
    const disabled = await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://push.example.test' },
      events: {
        [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true,
        [COMMUNITY_FEEDBACK_NOTIFICATION]: false,
      },
    })
    await service.updateSettings({
      expectedRevision: disabled.revision!,
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://push.example.test' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: false },
    })
    expect((await service.getSettings()).events[COMMUNITY_FEEDBACK_NOTIFICATION]).toBe(false)
    await expect(service.notifyCommunityFeedback({ kind: 'draft' })).resolves.toBe('skipped')
  })
  it('defaults to system notifications and browser push while the address channels stay off', async () => {
    const { service } = await createFixture()
    await expect(service.getSettings()).resolves.toEqual({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
      browserPush: { enabled: true },
      wecom: { enabled: false, webhookConfigured: false },
      ntfy: { enabled: false, serverUrl: 'https://ntfy.sh', topicConfigured: false, tokenConfigured: false },
      events: {
        [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true,
        [COMMUNITY_FEEDBACK_NOTIFICATION]: true,
        [CREDENTIAL_REQUEST_NOTIFICATION]: true,
        [EXTENSION_NOTIFICATION]: true,
      },
    })
  })

  it('tells about a credential request with a link to the pre-filled form, unless that event is off', async () => {
    const { service } = await createFixture()
    await expect(
      service.notifyCredentialRequest({
        requestId: 'crq_fixture',
        agentDisplayName: '示例智能体',
        name: '天气服务',
        purpose: '查天气',
        route: '/settings/credentials?add=1&name=%E5%A4%A9%E6%B0%94',
      }),
    ).resolves.toBe('sent')
    expect(service.readClientNotifications(0).notifications).toEqual([
      expect.objectContaining({
        id: 'credential-request:crq_fixture',
        body: '「示例智能体」需要凭据「天气服务」。用途：查天气',
        route: '/settings/credentials?add=1&name=%E5%A4%A9%E6%B0%94',
      }),
    ])
    await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://push.example.test' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true, [CREDENTIAL_REQUEST_NOTIFICATION]: false },
    })
    await expect(
      service.notifyCredentialRequest({
        requestId: 'crq_second',
        agentDisplayName: '示例智能体',
        name: '天气服务',
        purpose: '',
        route: '/settings/credentials?add=1',
      }),
    ).resolves.toBe('skipped')
  })

  it('keeps the Bark Device Key out of settings and fans one event out to both enabled channels', async () => {
    const { service, fetch } = await createFixture()
    await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: true, serverUrl: 'https://push.example.test', deviceKey: 'synthetic-device-key' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    const view = await service.getSettings()
    expect(view.bark).toEqual({
      enabled: true,
      serverUrl: 'https://push.example.test',
      deviceKeyConfigured: true,
    })
    expect(JSON.stringify(view)).not.toContain('synthetic-device-key')

    const cursor = service.readClientNotifications(undefined).cursor
    await expect(service.notifyDynamicApproval(approval)).resolves.toBe('sent')
    expect(service.readClientNotifications(cursor).notifications).toEqual([
      expect.objectContaining({
        id: 'dynamic-approval:agent_synthetic:plugin_synthetic',
        title: '有扩展等你试运行',
        route: '/workshop',
      }),
    ])
    const request = fetch.mock.calls[0]?.[1]
    expect(fetch).toHaveBeenCalledWith('https://push.example.test/push', expect.any(Object))
    expect(typeof request?.body).toBe('string')
    if (typeof request?.body === 'string') expect(request.body).toContain('synthetic-device-key')
  })

  it('starts a newly connected Desktop at the current cursor instead of replaying offline events', async () => {
    const { service } = await createFixture()
    await service.notifyDynamicApproval(approval)
    const connected = service.readClientNotifications(undefined)
    expect(connected.notifications).toEqual([])
    expect(connected.cursor).toBeGreaterThan(0)
  })

  it('honors the feature switch before either channel receives the event', async () => {
    const { service, fetch } = await createFixture()
    const saved = await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: false },
    })
    const cursor = service.readClientNotifications(undefined).cursor
    await expect(service.notifyDynamicApproval(approval)).resolves.toBe('skipped')
    expect(service.readClientNotifications(cursor).notifications).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(saved.revision).toBe(1)
  })

  it('reads settings saved before the extension switch existed as on', async () => {
    const { service, record } = await createFixture()
    record.set({
      version: 1,
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: false, [COMMUNITY_FEEDBACK_NOTIFICATION]: true },
    })
    const view = await service.getSettings()
    expect(view.events[EXTENSION_NOTIFICATION]).toBe(true)
    await service.updateSettings({
      expectedRevision: view.revision!,
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    expect((await service.getSettings()).events[EXTENSION_NOTIFICATION]).toBe(true)
  })

  it('sends extension notifications to the system and Bark channels unless the extension switch is off', async () => {
    const { service, fetch } = await createFixture()
    const saved = await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: true, serverUrl: 'https://push.example.test', deviceKey: 'synthetic-device-key' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    const cursor = service.readClientNotifications(undefined).cursor
    await expect(
      service.publishExtensionNotification({
        owner: 'extension:ext_weather',
        sourceName: '天气看板',
        title: '明天有雨',
        body: '记得带伞。',
        route: '/apps/hup_weather',
      }),
    ).resolves.toBe('sent')
    expect(service.readClientNotifications(cursor).notifications).toEqual([
      expect.objectContaining({ id: 'notice:extension:ext_weather', title: '明天有雨', route: '/apps/hup_weather' }),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
    const barkBody = fetch.mock.calls[0]?.[1]?.body
    expect(typeof barkBody).toBe('string')
    expect(JSON.parse(typeof barkBody === 'string' ? barkBody : '{}')).toMatchObject({
      title: '明天有雨',
      body: '记得带伞。',
      group: 'NekroNXT · 天气看板',
    })

    await service.updateSettings({
      expectedRevision: saved.revision!,
      system: { enabled: true },
      bark: { enabled: true, serverUrl: 'https://push.example.test' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true, [EXTENSION_NOTIFICATION]: false },
    })
    const after = service.readClientNotifications(undefined).cursor
    await expect(
      service.publishExtensionNotification({ owner: 'extension:ext_weather', title: '明天有雨', body: '记得带伞。' }),
    ).resolves.toBe('skipped')
    expect(service.readClientNotifications(after).notifications).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(() =>
      service.publishExtensionNotification({ owner: 'extension:ext_weather', title: '', body: '记得带伞。' }),
    ).toThrow()
  })

  it('keeps the system channel switch above the extension switch', async () => {
    const { service, fetch } = await createFixture()
    await service.updateSettings({
      system: { enabled: false },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    const cursor = service.readClientNotifications(undefined).cursor
    await expect(
      service.publishExtensionNotification({ owner: 'extension:ext_weather', title: '明天有雨', body: '记得带伞。' }),
    ).resolves.toBe('skipped')
    expect(service.readClientNotifications(cursor).notifications).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gives one id per source so clients replace instead of stacking', async () => {
    const { service } = await createFixture()
    const cursor = service.readClientNotifications(undefined).cursor
    await service.notifyDynamicApproval(approval)
    await service.notifyDynamicApproval({ ...approval, requestId: 'approval_second' })
    await service.notifyDynamicApproval({ ...approval, requestId: 'approval_other', pluginId: 'plugin_other' })
    await service.notifyCommunityFeedback({ kind: 'update', ref: 'FB-12' })
    await service.notifyCommunityFeedback({ kind: 'update', ref: 'FB-12' })
    await service.publishExtensionNotification({ owner: 'extension:ext_weather', title: '明天有雨', body: '带伞。' })
    await service.publishExtensionNotification({ owner: 'extension:ext_weather', title: '后天放晴', body: '晒被子。' })
    await service.publishExtensionNotification({
      owner: 'extension:ext_' + 'x'.repeat(200),
      title: '提醒',
      body: '内容',
    })
    const ids = service.readClientNotifications(cursor).notifications.map((item) => item.id)
    expect(ids.slice(0, 6)).toEqual([
      // The second request for the same waiting candidate is not announced again.
      'dynamic-approval:agent_synthetic:plugin_synthetic',
      'dynamic-approval:agent_synthetic:plugin_other',
      'feedback:FB-12',
      'feedback:FB-12',
      'notice:extension:ext_weather',
      'notice:extension:ext_weather',
    ])
    expect(ids[6]).toMatch(/^notice:[a-f0-9]{64}$/u)
  })

  it('announces a waiting candidate once an hour however often the runner asks again', async () => {
    let now = 1_000
    const { service } = await createFixture({ now: () => now })
    await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    await expect(service.notifyDynamicApproval(approval)).resolves.toBe('sent')
    now += 59 * 60 * 1000
    await expect(service.notifyDynamicApproval({ ...approval, requestId: 'approval_retry' })).resolves.toBe('skipped')
    now += 2 * 60 * 1000
    await expect(service.notifyDynamicApproval({ ...approval, requestId: 'approval_later' })).resolves.toBe('sent')
  })
  it('gives a client from an earlier run the current baseline instead of waiting for numbers it already saw', async () => {
    const { service } = await createFixture()
    const first = service.readClientNotifications(undefined, '')
    expect(first.bootId).toEqual(expect.any(String))
    await service.notifyCommunityFeedback({ kind: 'draft' })
    expect(service.readClientNotifications(first.cursor, first.bootId).notifications).toHaveLength(1)

    const restarted = (await createFixture()).service
    const baseline = restarted.readClientNotifications(first.cursor + 1, first.bootId)
    expect(baseline).toMatchObject({ cursor: 0, notifications: [] })
    expect(baseline.bootId).not.toBe(first.bootId)
    // An older client sends no run id: a cursor past the current count still gets the baseline, in the old shape.
    expect(restarted.readClientNotifications(5)).toEqual({ cursor: 0, notifications: [] })
  })

  it('holds a waiting read until a notification arrives, the time runs out or the client leaves', async () => {
    const { service } = await createFixture()
    const { cursor, bootId } = service.readClientNotifications(undefined, '')
    const waiting = service.waitClientNotifications({ cursor, boot: bootId!, waitMs: 30_000 })
    await service.notifyCommunityFeedback({ kind: 'draft' })
    await expect(waiting).resolves.toMatchObject({
      cursor: cursor + 1,
      notifications: [{ route: '/community/feedback' }],
    })

    vi.useFakeTimers()
    try {
      const quiet = service.waitClientNotifications({ cursor: cursor + 1, boot: bootId!, waitMs: 30_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(quiet).resolves.toMatchObject({ cursor: cursor + 1, notifications: [] })
    } finally {
      vi.useRealTimers()
    }

    const left = new AbortController()
    const abandoned = service.waitClientNotifications({ cursor: cursor + 1, waitMs: 30_000, signal: left.signal })
    left.abort()
    await expect(abandoned).resolves.toMatchObject({ notifications: [] })
    // A first read or a stale cursor answers right away.
    await expect(service.waitClientNotifications({ boot: '', waitMs: 30_000 })).resolves.toMatchObject({
      cursor: cursor + 1,
    })
    await expect(
      service.waitClientNotifications({ cursor: 0, boot: 'other-run', waitMs: 30_000 }),
    ).resolves.toMatchObject({
      notifications: [],
    })
  })
  it('keeps the WeCom webhook and ntfy topic out of settings and sends each in its own format', async () => {
    const { service, fetch, credentialFiles } = await createFixture()
    fetch.mockImplementation((url) =>
      Promise.resolve(
        urlOf(url).startsWith('https://qyapi.example.test')
          ? Response.json({ errcode: 0, errmsg: 'ok' })
          : new Response(null, { status: 200 }),
      ),
    )
    await expect(
      service.updateSettings({
        system: { enabled: false },
        bark: { enabled: false, serverUrl: 'https://api.day.app' },
        wecom: { enabled: true },
        events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
      }),
    ).rejects.toThrow('请先填写企业微信 Webhook 地址')
    const saved = await service.updateSettings({
      system: { enabled: false },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      wecom: { enabled: true, webhookUrl: 'https://qyapi.example.test/cgi-bin/webhook/send?key=synthetic-robot-key' },
      ntfy: {
        enabled: true,
        serverUrl: 'https://ntfy.example.test',
        topic: 'nxt-synthetic-topic',
        token: 'tk_synthetic',
      },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    expect(saved.wecom).toEqual({ enabled: true, webhookConfigured: true })
    expect(saved.ntfy).toEqual({
      enabled: true,
      serverUrl: 'https://ntfy.example.test',
      topicConfigured: true,
      tokenConfigured: true,
    })
    expect(JSON.stringify(saved)).not.toMatch(/synthetic-robot-key|nxt-synthetic-topic|tk_synthetic/u)
    expect(await credentialFiles()).toBe(3)

    await expect(service.notifyCommunityFeedback({ kind: 'update', ref: 'FB-7' })).resolves.toBe('sent')
    const calls = new Map(fetch.mock.calls.map(([url, init]) => [urlOf(url), init]))
    expect(bodyOf(calls.get('https://qyapi.example.test/cgi-bin/webhook/send?key=synthetic-robot-key'))).toEqual({
      msgtype: 'text',
      text: { content: '社区反馈有更新\n反馈 FB-7 有了新进展。' },
    })
    const ntfy = calls.get('https://ntfy.example.test')
    expect(ntfy?.headers).toMatchObject({ authorization: 'Bearer tk_synthetic' })
    expect(bodyOf(ntfy)).toEqual({
      topic: 'nxt-synthetic-topic',
      title: '社区反馈有更新',
      message: '反馈 FB-7 有了新进展。',
    })

    // A client that does not know these channels keeps them; clearing the token removes its credential.
    const older = await service.updateSettings({
      expectedRevision: saved.revision!,
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    expect(older.wecom.enabled).toBe(true)
    expect(older.ntfy.topicConfigured).toBe(true)
    const cleared = await service.updateSettings({
      expectedRevision: older.revision!,
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      ntfy: { enabled: true, serverUrl: 'https://ntfy.example.test', clearToken: true },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    expect(cleared.ntfy.tokenConfigured).toBe(false)
    expect(await credentialFiles()).toBe(2)
  })

  it('reports why a WeCom robot refused a test', async () => {
    const { service, fetch } = await createFixture()
    fetch.mockResolvedValue(Response.json({ errcode: 93000, errmsg: 'invalid webhook url' }))
    await expect(
      service.testWecom({ webhookUrl: 'https://qyapi.example.test/cgi-bin/webhook/send?key=synthetic' }),
    ).rejects.toThrow('企业微信拒绝了这条消息（93000：invalid webhook url）')
    fetch.mockRejectedValue(
      new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }),
    )
    await expect(service.testNtfy({ serverUrl: 'https://ntfy.example.test', topic: 'nxt-synthetic' })).rejects.toThrow(
      '连不上 ntfy（ntfy.example.test，ENOTFOUND）',
    )
  })

  it('sends on the other channels when one of them fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { service, fetch } = await createFixture()
      fetch.mockImplementation((url) =>
        urlOf(url).includes('push.example.test')
          ? Promise.reject(new TypeError('fetch failed'))
          : Promise.resolve(new Response(null, { status: 200 })),
      )
      await service.updateSettings({
        system: { enabled: false },
        bark: { enabled: true, serverUrl: 'https://push.example.test', deviceKey: 'synthetic-device-key' },
        ntfy: { enabled: true, serverUrl: 'https://ntfy.example.test', topic: 'nxt-synthetic' },
        events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
      })
      await expect(service.notifyCommunityFeedback({ kind: 'draft' })).resolves.toBe('sent')
      expect(fetch.mock.calls.map(([url]) => urlOf(url))).toEqual(
        expect.arrayContaining(['https://push.example.test/push', 'https://ntfy.example.test']),
      )
      expect(warn).toHaveBeenCalledWith('[nekro-nxt] Bark 通知没有发出：', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it('makes the VAPID key pair once and keeps the private key out of settings', async () => {
    const webPush = createWebPush()
    const { service, repository } = await createFixture({ pushStore: createPushStore(), webPush: webPush.sender })
    await expect(service.webPushPublicKey()).resolves.toBe('synthetic-public-key')
    await expect(service.webPushPublicKey()).resolves.toBe('synthetic-public-key')
    expect(webPush.generateVAPIDKeys).toHaveBeenCalledTimes(1)
    const stored = JSON.stringify(repository.getSystemSetting('notification-web-push-keys')?.value)
    expect(stored).toContain('synthetic-public-key')
    expect(stored).not.toContain('synthetic-private-key')
  })

  it('pushes to the browsers of active login devices, redacted, and drops subscriptions the browser gave up', async () => {
    const store = createPushStore()
    const webPush = createWebPush()
    const { service } = await createFixture({
      pushStore: store,
      webPush: webPush.sender,
      redact: (text) => text.replaceAll('sk-synthetic', '[已隐藏]'),
    })
    expect(() =>
      service.registerPushSubscription(deviceA, { ...subscriptionInput('http://push.example.test/a') }),
    ).toThrow('推送地址必须是 HTTPS')
    const phone = service.registerPushSubscription(deviceA, subscriptionInput('https://push.example.test/a'))
    service.registerPushSubscription(deviceB, subscriptionInput('https://push.example.test/b'))
    expect(phone).toMatchObject({
      id: pushSubscriptionId('https://push.example.test/a'),
      deviceLabel: '浏览器 · Safari · iOS',
    })
    expect(JSON.stringify(service.listPushSubscriptions())).not.toContain('push.example.test')

    await service.publishExtensionNotification({
      owner: 'notice-owner',
      title: '提醒',
      body: '密钥 sk-synthetic 快到期了',
    })
    expect(webPush.sent).toEqual([
      {
        endpoint: 'https://push.example.test/a',
        payload: { title: '提醒', body: '密钥 [已隐藏] 快到期了', route: '/', tag: 'notice:notice-owner' },
      },
      expect.objectContaining({ endpoint: 'https://push.example.test/b' }),
    ])
    expect(service.listPushSubscriptions()[0]?.lastDeliveredAt).toBe(1_725_000_000_000)

    webPush.failWith((endpoint) => (endpoint.endsWith('/a') ? pushError(410) : undefined))
    await expect(service.testPushSubscription(phone.id)).rejects.toThrow('这个订阅已经失效，已移除')
    expect(service.listPushSubscriptions().map((entry) => entry.deviceId)).toEqual([deviceB])

    webPush.failWith(() => new TypeError('fetch failed'))
    await expect(service.testPushSubscription(pushSubscriptionId('https://push.example.test/b'))).rejects.toThrow(
      '连不上推送服务（push.example.test）',
    )

    store.revoke(deviceB)
    expect(service.listPushSubscriptions()).toEqual([])
    expect(() => service.registerPushSubscription(deviceB, subscriptionInput('https://push.example.test/c'))).toThrow(
      '这台设备已经退出登录',
    )
  })

  it('leaves browsers alone when browser push is off', async () => {
    const webPush = createWebPush()
    const { service } = await createFixture({ pushStore: createPushStore(), webPush: webPush.sender })
    service.registerPushSubscription(deviceA, subscriptionInput('https://push.example.test/a'))
    await service.updateSettings({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app' },
      browserPush: { enabled: false },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    await service.notifyCommunityFeedback({ kind: 'draft' })
    expect(webPush.sent).toEqual([])
  })
  it('links Bark, ntfy and WeCom messages to the page at the access address', async () => {
    const { service, fetch } = await createFixture({ publicOrigin: 'https://nxt.example.test' })
    fetch.mockImplementation((url) =>
      Promise.resolve(
        urlOf(url).startsWith('https://qyapi.example.test')
          ? Response.json({ errcode: 0 })
          : new Response(null, { status: 200 }),
      ),
    )
    await service.updateSettings({
      system: { enabled: false },
      bark: { enabled: true, serverUrl: 'https://push.example.test', deviceKey: 'synthetic-device-key' },
      wecom: { enabled: true, webhookUrl: 'https://qyapi.example.test/send?key=synthetic' },
      ntfy: { enabled: true, serverUrl: 'https://ntfy.example.test', topic: 'nxt-synthetic' },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
    await service.notifyCommunityFeedback({ kind: 'draft' })
    const bodies = new Map(fetch.mock.calls.map(([url, init]) => [urlOf(url), bodyOf(init)]))
    const page = 'https://nxt.example.test/community/feedback'
    expect(bodies.get('https://push.example.test/push')).toMatchObject({ url: page })
    expect(bodies.get('https://ntfy.example.test')).toMatchObject({ click: page })
    expect(bodies.get('https://qyapi.example.test/send?key=synthetic')).toEqual({
      msgtype: 'text',
      text: { content: `有反馈等你确认\n可以在社区反馈页查看并发送。\n${page}` },
    })
  })
})
