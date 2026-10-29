import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { LocalCredentialStore } from '../src/credentials.js'
import {
  COMMUNITY_FEEDBACK_NOTIFICATION,
  CREDENTIAL_REQUEST_NOTIFICATION,
  DYNAMIC_CLIENT_APPROVAL_NOTIFICATION,
  EXTENSION_NOTIFICATION,
  NotificationService,
} from '../src/notifications.js'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-notifications-'))
  temporaryRoots.push(root)
  let record: SystemSettingRecord | undefined
  const repository = {
    getSystemSetting: () => record,
    putSystemSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => {
      if (record?.revision !== expectedRevision || (record === undefined && expectedRevision !== undefined)) {
        throw new Error('System setting revision conflict.')
      }
      record = { key, value, revision: (record?.revision ?? 0) + 1, updatedAt }
      return record
    },
  }
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 200 })))
  const service = new NotificationService(repository, new LocalCredentialStore(path.join(root, 'credentials')), {
    fetch,
    now: () => 1_725_000_000_000,
  })
  return {
    service,
    fetch,
    record: {
      set: (value: JsonValue) => {
        record = { key: 'notifications', value, revision: (record?.revision ?? 0) + 1, updatedAt: 1 }
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
  it('defaults to Desktop system notifications while keeping Bark disabled', async () => {
    const { service } = await createFixture()
    await expect(service.getSettings()).resolves.toEqual({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
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
    expect(ids.slice(0, 7)).toEqual([
      'dynamic-approval:agent_synthetic:plugin_synthetic',
      'dynamic-approval:agent_synthetic:plugin_synthetic',
      'dynamic-approval:agent_synthetic:plugin_other',
      'feedback:FB-12',
      'feedback:FB-12',
      'notice:extension:ext_weather',
      'notice:extension:ext_weather',
    ])
    expect(ids[7]).toMatch(/^notice:[a-f0-9]{64}$/u)
  })
})
