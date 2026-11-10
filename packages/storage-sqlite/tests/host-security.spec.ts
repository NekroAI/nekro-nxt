import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagementDeviceIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const openRepository = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-host-security-'))
  roots.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  const repository = new SqliteHostSecurityRepository(database)
  const device = (suffix: string) => {
    const id = ManagementDeviceIdSchema.parse(`nxt_device_${suffix.padEnd(26, '0')}`)
    repository.putDevice({ id, label: `浏览器 ${suffix}`, secretDigest: 'digest', createdAt: 1 })
    return id
  }
  return { repository, device, close: () => database.close() }
}

const subscription = (endpoint: string, deviceId: ReturnType<typeof ManagementDeviceIdSchema.parse>) => ({
  endpoint,
  deviceId,
  p256dh: 'p256dh-key',
  auth: 'auth-secret',
  label: 'iPhone · 主屏幕',
  createdAt: 10,
})

describe('SqliteHostSecurityRepository push subscriptions', () => {
  it('keeps one row per endpoint and removes a device subscriptions when the device is revoked', async () => {
    const { repository, device, close } = await openRepository()
    try {
      const phone = device('A')
      const laptop = device('B')
      repository.putPushSubscription(subscription('https://push.example.test/a', phone))
      repository.putPushSubscription(subscription('https://push.example.test/b', laptop))
      // The same browser subscribing again after logging in as another device moves the row.
      repository.putPushSubscription(subscription('https://push.example.test/b', phone))
      repository.markPushDelivered('https://push.example.test/a', 20)
      expect(repository.listPushSubscriptions()).toEqual([
        expect.objectContaining({ endpoint: 'https://push.example.test/a', deviceId: phone, lastDeliveredAt: 20 }),
        expect.objectContaining({ endpoint: 'https://push.example.test/b', deviceId: phone }),
      ])

      repository.putPushSubscription(subscription('https://push.example.test/c', laptop))
      expect(repository.revokeDevice(phone, 30)).toBe(true)
      expect(repository.listPushSubscriptions().map((entry) => entry.endpoint)).toEqual(['https://push.example.test/c'])

      expect(repository.deletePushSubscriptions(['https://push.example.test/c'])).toBe(1)
      repository.putPushSubscription(subscription('https://push.example.test/d', laptop))
      repository.revokeAllDevices(40)
      expect(repository.listPushSubscriptions()).toEqual([])
    } finally {
      close()
    }
  })
})
