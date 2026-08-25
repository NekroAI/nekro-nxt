import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { LocalCredentialStore } from '../src/credentials.js'
import { DYNAMIC_CLIENT_APPROVAL_NOTIFICATION, NotificationService } from '../src/notifications.js'

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
  return { service, fetch }
}

const approval = {
  requestId: 'approval_synthetic',
  agentDisplayName: '资料员',
  extensionName: '文档复核',
  purpose: '检查遗漏',
}

describe('NotificationService', () => {
  it('defaults to Desktop system notifications while keeping Bark disabled', async () => {
    const { service } = await createFixture()
    await expect(service.getSettings()).resolves.toEqual({
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
      events: { [DYNAMIC_CLIENT_APPROVAL_NOTIFICATION]: true },
    })
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
        id: 'dynamic-approval:approval_synthetic',
        title: '扩展预览等待确认',
        route: '/work/creator',
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
})
