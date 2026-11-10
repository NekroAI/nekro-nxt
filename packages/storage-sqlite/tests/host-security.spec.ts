import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagementDeviceIdSchema, ServerInstanceIdSchema } from '@nekro-nxt/contracts'
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

describe('SqliteHostSecurityRepository passkeys and key sign-in', () => {
  it('keeps passkeys per host name, moves the counter forward and turns key sign-in off and on', async () => {
    const { repository, close } = await openRepository()
    try {
      repository.putMetadata({
        instanceId: ServerInstanceIdSchema.parse('nxt_instance_01J0000000000000000000000A'),
        managementKeyDigest: 'digest',
        createdAt: 1,
        updatedAt: 1,
      })
      expect(repository.keySignIn()).toBe(true)
      repository.setKeySignIn(false, 2)
      expect(repository.keySignIn()).toBe(false)
      // Rotating the key rewrites the metadata row and keeps the choice.
      repository.putMetadata({
        instanceId: ServerInstanceIdSchema.parse('nxt_instance_01J0000000000000000000000A'),
        managementKeyDigest: 'rotated',
        createdAt: 1,
        updatedAt: 3,
      })
      expect(repository.keySignIn()).toBe(false)

      repository.putPasskey({
        id: 'credential-a',
        rpId: 'nxt.example.test',
        publicKey: 'public-a',
        counter: 0,
        transports: ['internal', 'hybrid'],
        label: 'iPhone',
        createdAt: 10,
      })
      repository.putPasskey({
        id: 'credential-b',
        rpId: 'localhost',
        publicKey: 'public-b',
        counter: 0,
        label: 'Mac',
        createdAt: 11,
      })
      expect(repository.listPasskeys('nxt.example.test').map((entry) => entry.id)).toEqual(['credential-a'])
      repository.usePasskey('credential-a', 4, 20)
      expect(repository.getPasskey('credential-a')).toMatchObject({
        counter: 4,
        lastUsedAt: 20,
        transports: ['internal', 'hybrid'],
      })
      expect(repository.deletePasskey('credential-b')).toBe(true)
      expect(repository.listPasskeys().map((entry) => entry.id)).toEqual(['credential-a'])
    } finally {
      close()
    }
  })
})
