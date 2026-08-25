import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { InstanceDescriptorSchema, ManagementDeviceIdSchema } from '@nekro-nxt/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstanceProfileStore, normalizeRemoteOrigin } from '../src/instance-profiles.ts'
import {
  addRemoteProfile,
  editRemoteProfileConnection,
  reauthenticateRemoteProfile,
} from '../src/remote-profile-enrollment.ts'
import { enrollRemoteDevice, type PairRemoteResult, type RemoteInspection } from '../src/remote-pairing.ts'
import { SerialTaskQueue } from '../src/serial-task-queue.ts'

const REMOTE_HTTP_TEST_IP = [192, 0, 2, 44].join('.')

const descriptor = (
  instanceId: string,
  transport: 'loopback-http' | 'auto-tls-pinned-v1' | 'explicit-http-v1' = 'auto-tls-pinned-v1',
): PairRemoteResult['descriptor'] =>
  InstanceDescriptorSchema.parse({
    format: 'nxt.instance-descriptor',
    descriptorVersion: 1,
    instanceId,
    releaseId: 'nxt.test-release',
    productVersion: '0.0.0-test',
    managementProtocol: transport === 'explicit-http-v1' ? 2 : 1,
    desktopChromeProtocol: 1,
    transport,
  })

const inspection = (origin: string, instanceId: string, spkiSha256 = 'test-spki'): RemoteInspection => ({
  origin: normalizeRemoteOrigin(origin),
  descriptor: descriptor(instanceId),
  spkiSha256,
})

const enrollment = (inspected: RemoteInspection, suffix = '00'): PairRemoteResult => ({
  ...inspected,
  deviceId: ManagementDeviceIdSchema.parse(`nxt_device_01H000000000000000000000${suffix}`),
  deviceSecret: `secret-${suffix}`,
})

describe('Desktop remote Profile enrollment', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  const openStore = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-profile-enrollment-'))
    roots.push(root)
    return InstanceProfileStore.open(path.join(root, 'profiles.json'), 'http://127.0.0.1:41005', 100)
  }

  const credentials = () => {
    const values = new Set<string>()
    return {
      values,
      store: {
        put: () => {
          values.add('new-credential')
          return Promise.resolve('new-credential')
        },
        remove: (reference: string) => {
          values.delete(reference)
          return Promise.resolve()
        },
      },
    }
  }

  it('rejects a known instance during inspection before creating a device', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000010'
    await profiles.addRemote({
      displayName: '已有实例',
      origin: 'known.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'known-spki',
    })
    const inspected = inspection('alias.example', instanceId)
    const enroll = vi.fn(() => Promise.resolve(enrollment(inspected)))
    const revoke = vi.fn(() => Promise.resolve())
    const credentialStore = credentials()

    await expect(
      addRemoteProfile({
        profiles,
        credentials: credentialStore.store,
        displayName: '重复实例',
        address: inspected.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect: () => Promise.resolve(inspected), enroll, revoke },
      }),
    ).rejects.toThrow('已经添加')
    expect(enroll).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(credentialStore.values.size).toBe(0)
  })

  it('pairs a loopback HTTP instance without a management key or bogus device credential', async () => {
    const profiles = await openStore()
    const inspected: RemoteInspection = {
      origin: 'http://127.0.0.1:4960',
      descriptor: descriptor('nxt_instance_01H00000000000000000000022', 'loopback-http'),
    }
    const enroll = vi.fn(enrollRemoteDevice)
    const credentialStore = credentials()

    const added = await addRemoteProfile({
      profiles,
      credentials: credentialStore.store,
      displayName: '无密钥本机实例',
      address: inspected.origin,
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: { inspect: () => Promise.resolve(inspected), enroll, revoke: () => Promise.resolve() },
    })

    expect(enroll).toHaveBeenCalledOnce()
    expect(enroll.mock.calls[0]?.[0]).not.toHaveProperty('managementKey')
    expect(added.credential).toBeUndefined()
    expect(added.profile).toMatchObject({ origin: inspected.origin })
    expect(credentialStore.values.size).toBe(0)
  })

  it('stores device credentials for a confirmed explicit HTTP transport without inventing SPKI', async () => {
    const profiles = await openStore()
    const inspected: RemoteInspection = {
      origin: `http://${REMOTE_HTTP_TEST_IP}:4960`,
      descriptor: descriptor('nxt_instance_01H00000000000000000000026', 'explicit-http-v1'),
    }
    const paired = enrollment(inspected, '06')
    const credentialStore = credentials()
    const added = await addRemoteProfile({
      profiles,
      credentials: credentialStore.store,
      displayName: '显式 HTTP 实例',
      address: inspected.origin,
      managementKey: 'm'.repeat(32),
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: {
        inspect: () => Promise.resolve(inspected),
        enroll: () => Promise.resolve(paired),
        revoke: () => Promise.resolve(),
      },
    })
    expect(added.profile).toMatchObject({ transport: 'explicit-http-v1', credentialRef: 'new-credential' })
    expect(added.profile.pinnedSpkiSha256).toBeUndefined()
    expect(added.credential).toBeDefined()
  })

  it('requires a management key for TLS pairing before sending an enrollment request', async () => {
    const inspected = inspection('key-required.example', 'nxt_instance_01H00000000000000000000023')
    await expect(
      enrollRemoteDevice({
        inspection: inspected,
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
      }),
    ).rejects.toThrow('需要管理密钥')
  })

  it('rejects an exact normalized origin before remote inspection', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000018'
    await profiles.addRemote({
      displayName: '已有地址',
      origin: 'same-origin.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'known-spki',
    })
    const inspect = vi.fn(() =>
      Promise.resolve(inspection('same-origin.example', 'nxt_instance_01H00000000000000000000019')),
    )
    const enroll = vi.fn(() => Promise.resolve(enrollment(inspection('same-origin.example', instanceId), '05')))

    await expect(
      addRemoteProfile({
        profiles,
        credentials: credentials().store,
        displayName: '重复地址',
        address: 'https://same-origin.example:4960/',
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect, enroll, revoke: () => Promise.resolve() },
      }),
    ).rejects.toThrow('已经添加')
    expect(inspect).not.toHaveBeenCalled()
    expect(enroll).not.toHaveBeenCalled()
  })

  it('removes the new credential and revokes enrollment when the Profile commit fails', async () => {
    const profiles = await openStore()
    const inspected = inspection('commit-failure.example', 'nxt_instance_01H00000000000000000000011')
    const paired = enrollment(inspected, '01')
    const credentialStore = credentials()
    const revoke = vi.fn(() => Promise.resolve())
    const addRemote = vi
      .spyOn(profiles, 'addRemote')
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')))

    await expect(
      addRemoteProfile({
        profiles,
        credentials: credentialStore.store,
        displayName: '提交失败实例',
        address: inspected.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: {
          inspect: () => Promise.resolve(inspected),
          enroll: () => Promise.resolve(paired),
          revoke,
        },
      }),
    ).rejects.toThrow('disk full')

    expect(addRemote).toHaveBeenCalledOnce()
    expect(profiles.list()).toHaveLength(1)
    expect(credentialStore.values.size).toBe(0)
    expect(revoke).toHaveBeenCalledWith(paired)
  })

  it('revokes enrollment and creates no Profile when credential persistence fails', async () => {
    const profiles = await openStore()
    const inspected = inspection('vault-failure.example', 'nxt_instance_01H00000000000000000000016')
    const paired = enrollment(inspected, '04')
    const revoke = vi.fn(() => Promise.resolve())
    const addRemote = vi.spyOn(profiles, 'addRemote')

    await expect(
      addRemoteProfile({
        profiles,
        credentials: {
          put: () => Promise.reject(new Error('vault unavailable')),
          remove: () => Promise.resolve(),
        },
        displayName: '凭据失败实例',
        address: inspected.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: {
          inspect: () => Promise.resolve(inspected),
          enroll: () => Promise.resolve(paired),
          revoke,
        },
      }),
    ).rejects.toThrow('vault unavailable')

    expect(addRemote).not.toHaveBeenCalled()
    expect(profiles.list()).toHaveLength(1)
    expect(revoke).toHaveBeenCalledWith(paired)
  })

  it('serializes concurrent additions so the second duplicate stops before enrollment', async () => {
    const profiles = await openStore()
    const inspected = inspection('serialized.example', 'nxt_instance_01H00000000000000000000012')
    const paired = enrollment(inspected, '02')
    const credentialStore = credentials()
    const queue = new SerialTaskQueue()
    let finishEnrollment!: () => void
    const enrollmentGate = new Promise<void>((resolve) => {
      finishEnrollment = resolve
    })
    const inspect = vi.fn(() => Promise.resolve(inspected))
    const enroll = vi.fn(async () => {
      await enrollmentGate
      return paired
    })
    const gateway = { inspect, enroll, revoke: () => Promise.resolve() }
    const add = () =>
      addRemoteProfile({
        profiles,
        credentials: credentialStore.store,
        displayName: '串行实例',
        address: inspected.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway,
      })

    const first = queue.run(add)
    const second = queue.run(add)
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce())
    expect(inspect).toHaveBeenCalledOnce()
    finishEnrollment()
    await expect(first).resolves.toMatchObject({ profile: { origin: inspected.origin } })
    await expect(second).rejects.toThrow('已经添加')
    expect(enroll).toHaveBeenCalledOnce()
    expect(profiles.list()).toHaveLength(2)
  })

  it('keeps the original Profile when reauthentication observes another instance identity', async () => {
    const profiles = await openStore()
    const profile = await profiles.addRemote({
      displayName: '固定身份实例',
      origin: 'immutable.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000013',
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const before = profiles.get(profile.id)
    const changed = inspection(profile.origin, 'nxt_instance_01H00000000000000000000014', 'new-spki')
    const enroll = vi.fn(() => Promise.resolve(enrollment(changed, '03')))

    await expect(
      reauthenticateRemoteProfile({
        profiles,
        credentials: credentials().store,
        profileId: profile.id,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect: () => Promise.resolve(changed), enroll, revoke: () => Promise.resolve() },
      }),
    ).rejects.toThrow('添加为新的服务实例')
    expect(enroll).not.toHaveBeenCalled()
    expect(profiles.get(profile.id)).toEqual(before)
  })

  it('renames a remote Profile without network I/O or partition rotation when the address is unchanged', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000050'
    const profile = await profiles.addRemote({
      displayName: '旧名称',
      origin: 'rename-edit.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'fixed-spki',
      credentialRef: 'fixed-credential',
    })
    const inspect = vi.fn()
    const enroll = vi.fn()
    const revoke = vi.fn()
    const result = await editRemoteProfileConnection({
      profiles,
      credentials: credentials().store,
      profileId: profile.id,
      displayName: '新名称',
      address: profile.origin,
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: { inspect, enroll, revoke },
    })
    expect(result.profile).toMatchObject({
      id: profile.id,
      displayName: '新名称',
      origin: profile.origin,
      partition: profile.partition,
      credentialRef: 'fixed-credential',
    })
    expect(result.credential).toBeUndefined()
    expect(result.replaced).toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()
    expect(enroll).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('renames a keyless loopback Profile without inventing security fields', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000051'
    const origin = 'http://127.0.0.1:4960'
    const profile = await profiles.addRemote({
      displayName: '旧本机实例',
      origin,
      observedInstanceId: instanceId,
    })
    const result = await editRemoteProfileConnection({
      profiles,
      credentials: credentials().store,
      profileId: profile.id,
      displayName: '新本机实例',
      address: origin,
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: { inspect: vi.fn(), enroll: vi.fn(), revoke: vi.fn() },
    })
    expect(result.profile).toMatchObject({
      id: profile.id,
      displayName: '新本机实例',
      origin,
      partition: profile.partition,
    })
    expect(result.profile.pinnedSpkiSha256).toBeUndefined()
    expect(result.profile.credentialRef).toBeUndefined()
    expect(result.replaced).toBeUndefined()
  })

  it('reauthenticates the unchanged address and atomically commits the name and new security fields', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000052'
    const profile = await profiles.addRemote({
      displayName: '旧名称',
      origin: 'reauth-edit.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const inspected = inspection(profile.origin, instanceId, 'new-spki')
    const paired = enrollment(inspected, '20')
    const credentialStore = credentials()
    const result = await editRemoteProfileConnection({
      profiles,
      credentials: credentialStore.store,
      profileId: profile.id,
      displayName: '新名称',
      address: profile.origin,
      managementKey: 'm'.repeat(32),
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: {
        inspect: () => Promise.resolve(inspected),
        enroll: () => Promise.resolve(paired),
        revoke: () => Promise.resolve(),
      },
    })
    expect(result.profile).toMatchObject({
      id: profile.id,
      displayName: '新名称',
      origin: profile.origin,
      partition: profile.partition,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
    expect(result.credential).toBeDefined()
    expect(result.replaced).toEqual({ credentialRef: 'old-credential' })
    expect(credentialStore.values.has('new-credential')).toBe(true)
  })

  it('migrates a Profile to a new address of the same instance keeping its id and rotating the partition', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000053'
    const profile = await profiles.addRemote({
      displayName: '旧地址',
      origin: 'old-home.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const inspected = inspection('new-home.example', instanceId, 'new-spki')
    const paired = enrollment(inspected, '21')
    const credentialStore = credentials()
    const result = await editRemoteProfileConnection({
      profiles,
      credentials: credentialStore.store,
      profileId: profile.id,
      displayName: '新地址',
      address: 'new-home.example',
      managementKey: 'm'.repeat(32),
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: {
        inspect: () => Promise.resolve(inspected),
        enroll: () => Promise.resolve(paired),
        revoke: () => Promise.resolve(),
      },
    })
    expect(result.profile.id).toBe(profile.id)
    expect(result.profile).toMatchObject({
      displayName: '新地址',
      origin: 'https://new-home.example:4960',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
      transport: 'auto-tls-pinned-v1',
    })
    expect(result.profile.partition).not.toBe(profile.partition)
    expect(result.profile.partition).toMatch(/^persist:nxt-instance-/u)
    expect(result.replaced).toEqual({ partition: profile.partition, credentialRef: 'old-credential' })
    expect(credentialStore.values.has('new-credential')).toBe(true)
  })

  it('migrates a Profile to a confirmed explicit HTTP address without inventing SPKI', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000061'
    const profile = await profiles.addRemote({
      displayName: '旧地址',
      origin: 'old-tls.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const inspected: RemoteInspection = {
      origin: `http://${REMOTE_HTTP_TEST_IP}:4960`,
      descriptor: descriptor(instanceId, 'explicit-http-v1'),
    }
    const paired = enrollment(inspected, '24')
    const credentialStore = credentials()
    const result = await editRemoteProfileConnection({
      profiles,
      credentials: credentialStore.store,
      profileId: profile.id,
      displayName: '显式 HTTP',
      address: inspected.origin,
      managementKey: 'm'.repeat(32),
      deviceLabel: 'NekroNXT test device',
      clientReleaseId: 'nxt.test-release',
      gateway: {
        inspect: () => Promise.resolve(inspected),
        enroll: () => Promise.resolve(paired),
        revoke: () => Promise.resolve(),
      },
    })
    expect(result.profile).toMatchObject({
      id: profile.id,
      origin: `http://${REMOTE_HTTP_TEST_IP}:4960`,
      transport: 'explicit-http-v1',
      observedInstanceId: instanceId,
      credentialRef: 'new-credential',
    })
    expect(result.profile.pinnedSpkiSha256).toBeUndefined()
    expect(result.profile.partition).not.toBe(profile.partition)
    expect(result.replaced).toEqual({ partition: profile.partition, credentialRef: 'old-credential' })
  })

  it('rejects migrating to an address that returns another instance identity before enrollment', async () => {
    const profiles = await openStore()
    const profile = await profiles.addRemote({
      displayName: '原实例',
      origin: 'original.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000054',
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const before = profiles.get(profile.id)
    const other = inspection('relocated.example', 'nxt_instance_01H00000000000000000000055')
    const enroll = vi.fn(() => Promise.resolve(enrollment(other, '22')))
    const credentialStore = credentials()
    await expect(
      editRemoteProfileConnection({
        profiles,
        credentials: credentialStore.store,
        profileId: profile.id,
        displayName: '不应成功',
        address: 'relocated.example',
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect: () => Promise.resolve(other), enroll, revoke: () => Promise.resolve() },
      }),
    ).rejects.toThrow('另一个服务实例')
    expect(enroll).not.toHaveBeenCalled()
    expect(credentialStore.values.size).toBe(0)
    expect(profiles.get(profile.id)).toEqual(before)
  })

  it('rejects a candidate address already owned by another Profile before network I/O', async () => {
    const profiles = await openStore()
    const first = await profiles.addRemote({
      displayName: '已有实例',
      origin: 'taken.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000056',
      pinnedSpkiSha256: 'spki-taken',
    })
    const profile = await profiles.addRemote({
      displayName: '要编辑实例',
      origin: 'editing.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000057',
      pinnedSpkiSha256: 'spki-editing',
    })
    const inspect = vi.fn()
    await expect(
      editRemoteProfileConnection({
        profiles,
        credentials: credentials().store,
        profileId: profile.id,
        displayName: '撞地址',
        address: first.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect, enroll: vi.fn(), revoke: vi.fn() },
      }),
    ).rejects.toThrow('已经添加')
    expect(inspect).not.toHaveBeenCalled()
    expect(profiles.get(profile.id)).toMatchObject({
      origin: 'https://editing.example:4960',
      displayName: '要编辑实例',
    })
  })

  it('removes the new credential and revokes the new device when the migrated commit fails', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000058'
    const profile = await profiles.addRemote({
      displayName: '旧地址',
      origin: 'old-migrate.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })
    const inspected = inspection('new-migrate.example', instanceId, 'new-spki')
    const paired = enrollment(inspected, '23')
    const credentialStore = credentials()
    const revoke = vi.fn(() => Promise.resolve())
    const updateRemoteConnection = vi
      .spyOn(profiles, 'updateRemoteConnection')
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')))
    await expect(
      editRemoteProfileConnection({
        profiles,
        credentials: credentialStore.store,
        profileId: profile.id,
        displayName: '提交失败',
        address: 'new-migrate.example',
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: {
          inspect: () => Promise.resolve(inspected),
          enroll: () => Promise.resolve(paired),
          revoke,
        },
      }),
    ).rejects.toThrow('disk full')
    expect(updateRemoteConnection).toHaveBeenCalledOnce()
    expect(credentialStore.values.size).toBe(0)
    expect(revoke).toHaveBeenCalledWith(paired)
    expect(profiles.get(profile.id)).toMatchObject({
      origin: 'https://old-migrate.example:4960',
      displayName: '旧地址',
      credentialRef: 'old-credential',
    })
  })

  it('rejects keyless migration to a TLS address before the vault writes', async () => {
    const profiles = await openStore()
    const instanceId = 'nxt_instance_01H00000000000000000000059'
    const profile = await profiles.addRemote({
      displayName: '旧地址',
      origin: 'old-keyless.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'spki-keyless',
    })
    const inspected = inspection('new-keyless.example', instanceId)
    const credentialStore = credentials()
    await expect(
      editRemoteProfileConnection({
        profiles,
        credentials: credentialStore.store,
        profileId: profile.id,
        displayName: '新地址',
        address: 'new-keyless.example',
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: {
          inspect: () => Promise.resolve(inspected),
          enroll: enrollRemoteDevice,
          revoke: () => Promise.resolve(),
        },
      }),
    ).rejects.toThrow('需要管理密钥')
    expect(credentialStore.values.size).toBe(0)
    expect(profiles.get(profile.id)).toMatchObject({ origin: 'https://old-keyless.example:4960' })
  })

  it('rejects keyed reauthentication for a keyless loopback Profile', async () => {
    const profiles = await openStore()
    const profile = await profiles.addRemote({
      displayName: '本机实例',
      origin: 'http://127.0.0.1:4960',
      observedInstanceId: 'nxt_instance_01H00000000000000000000060',
    })
    const inspect = vi.fn()
    await expect(
      editRemoteProfileConnection({
        profiles,
        credentials: credentials().store,
        profileId: profile.id,
        displayName: '新本机实例',
        address: profile.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: { inspect, enroll: vi.fn(), revoke: vi.fn() },
      }),
    ).rejects.toThrow('不需要重新认证')
    expect(inspect).not.toHaveBeenCalled()
  })
})
