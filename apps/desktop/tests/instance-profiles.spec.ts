import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InstanceProfileStore,
  assertInsecureHttpConfirmed,
  normalizeRemoteOrigin,
  remoteTransportForOrigin,
} from '../src/instance-profiles.ts'

const TEST_IP = [203, 0, 113, 8].join('.')

describe('Desktop instance profiles', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('accepts host, explicit HTTPS, and explicit HTTP addresses with standard-port preservation', () => {
    expect(normalizeRemoteOrigin(TEST_IP)).toBe(`https://${TEST_IP}:4960`)
    expect(normalizeRemoteOrigin('home.example:7443')).toBe('https://home.example:7443')
    expect(normalizeRemoteOrigin('https://home.example:7443')).toBe('https://home.example:7443')
    expect(normalizeRemoteOrigin('https://home.example:443')).toBe('https://home.example')
    expect(normalizeRemoteOrigin('http://127.0.0.1:7443')).toBe('http://127.0.0.1:7443')
    expect(normalizeRemoteOrigin('http://127.0.0.1:80')).toBe('http://127.0.0.1')
    expect(normalizeRemoteOrigin('http://localhost')).toBe('http://localhost:4960')
    expect(normalizeRemoteOrigin('https://[2001:db8::8]:443')).toBe('https://[2001:db8::8]')
    expect(normalizeRemoteOrigin('https://[2001:db8::8]')).toBe('https://[2001:db8::8]:4960')
    expect(normalizeRemoteOrigin('http://[::1]:80')).toBe('http://[::1]')
    expect(normalizeRemoteOrigin('http://[::1]')).toBe('http://[::1]:4960')
    expect(normalizeRemoteOrigin('http://home.example')).toBe('http://home.example:4960')
    expect(() => normalizeRemoteOrigin('ftp://home.example')).toThrow('只支持 HTTPS 或 HTTP')
    expect(() => normalizeRemoteOrigin('home.example/path')).toThrow('不能包含路径')
    expect(() => normalizeRemoteOrigin('user:pass@home.example')).toThrow('不能包含账号')
    try {
      normalizeRemoteOrigin('https://private-user:private-pass@home.example')
    } catch (error) {
      expect(String(error)).not.toContain('private-user')
      expect(String(error)).not.toContain('private-pass')
    }
  })

  it('stores a keyless loopback remote without inventing TLS or credential fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-loopback-'))
    roots.push(root)
    const store = await InstanceProfileStore.open(path.join(root, 'profiles.json'), 'http://127.0.0.1:41009', 100)
    const profile = await store.addRemote({
      displayName: '本机测试实例',
      origin: 'http://127.0.0.1:4961',
      observedInstanceId: 'nxt_instance_01H00000000000000000000021',
    })
    expect(profile).toMatchObject({ origin: 'http://127.0.0.1:4961' })
    expect(profile.pinnedSpkiSha256).toBeUndefined()
    expect(profile.credentialRef).toBeUndefined()
  })

  it('requires an exact normalized confirmation only for explicit remote HTTP', () => {
    const remoteHttp = normalizeRemoteOrigin('http://home.example:80')
    expect(remoteTransportForOrigin(remoteHttp)).toBe('explicit-http-v1')
    expect(() => assertInsecureHttpConfirmed(remoteHttp, undefined)).toThrow(
      expect.objectContaining({ code: 'insecure-http-confirmation-required' }),
    )
    expect(() => assertInsecureHttpConfirmed(remoteHttp, 'http://home.example:4960')).toThrow(
      expect.objectContaining({ code: 'insecure-http-confirmation-required' }),
    )
    expect(() => assertInsecureHttpConfirmed(remoteHttp, remoteHttp)).not.toThrow()
    expect(() => assertInsecureHttpConfirmed('http://127.0.0.1:4960', undefined)).not.toThrow()
  })

  it('keeps local first, preserves remote insertion order, and removes only the client profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-profile-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41000', 100)
    const first = await store.addRemote({
      displayName: '云服务器 A',
      origin: 'remote-a.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000000',
      pinnedSpkiSha256: 'spki-a',
      now: 200,
    })
    const second = await store.addRemote({
      displayName: '',
      origin: `${TEST_IP}:7000`,
      observedInstanceId: 'nxt_instance_01H00000000000000000000001',
      pinnedSpkiSha256: 'spki-b',
      now: 300,
    })
    expect(store.list().map(({ displayName }) => displayName)).toEqual(['本地实例', '云服务器 A', `${TEST_IP}:7000`])
    expect(store.selectedProfileId).toBe(second.id)
    await expect(store.remove('local')).rejects.toThrow('不能移除')
    await store.remove(first.id)
    expect(store.list().map(({ id }) => id)).toEqual(['local', second.id])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, selectedProfileId: second.id })
  })

  it('rejects duplicate normalized origins and observed instance identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-duplicate-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41002', 100)
    const first = await store.addRemote({
      displayName: '云服务器 A',
      origin: 'duplicate.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000002',
      pinnedSpkiSha256: 'spki-a',
      credentialRef: 'credential-a',
      now: 200,
    })
    await expect(
      store.addRemote({
        displayName: '重复地址',
        origin: 'https://duplicate.example:4960/',
        observedInstanceId: 'nxt_instance_01H00000000000000000000004',
        pinnedSpkiSha256: 'spki-c',
      }),
    ).rejects.toThrow('已经添加')
    await expect(
      store.addRemote({
        displayName: '重复身份',
        origin: 'other.example',
        observedInstanceId: 'nxt_instance_01H00000000000000000000002',
        pinnedSpkiSha256: 'spki-different',
      }),
    ).rejects.toThrow('已经添加')
    expect(store.get(first.id)?.origin).toBe('https://duplicate.example:4960')
    expect(store.list()).toHaveLength(2)
  })

  it('preserves a damaged future envelope as a recovery file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-recovery-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    await writeFile(file, '{"format":"nxt.desktop-instance-profiles","version":99}', 'utf8')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41001', 1234)
    expect(store.list()).toHaveLength(1)
    expect(await readFile(`${file}.recovery-1234`, 'utf8')).toContain('"version":99')
  })

  it('rejects duplicate normalized origins already present in a stored envelope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-stored-duplicate-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const remote = (id: string, origin: string, instanceId: string) => ({
      id,
      kind: 'remote',
      displayName: id,
      origin,
      observedInstanceId: instanceId,
      pinnedSpkiSha256: `spki-${id}`,
      partition: `persist:nxt-instance-${id}`,
      notificationsEnabled: true,
      lastRoute: '/work',
      addedAt: 200,
      lastSelectedAt: 200,
    })
    await writeFile(
      file,
      JSON.stringify({
        format: 'nxt.desktop-instance-profiles',
        version: 1,
        selectedProfileId: 'remote-a',
        profiles: [
          {
            id: 'local',
            kind: 'local',
            displayName: '本地实例',
            origin: 'http://127.0.0.1:41004',
            partition: 'persist:nxt-instance-local',
            notificationsEnabled: true,
            lastRoute: '/work',
            addedAt: 100,
            lastSelectedAt: 100,
          },
          remote('remote-a', 'https://duplicate.example', 'nxt_instance_01H00000000000000000000008'),
          remote('remote-b', 'https://duplicate.example:4960/', 'nxt_instance_01H00000000000000000000009'),
        ],
      }),
      'utf8',
    )

    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41004', 5678)
    expect(store.list().map(({ id }) => id)).toEqual(['local'])
    expect(await readFile(`${file}.recovery-5678`, 'utf8')).toContain('duplicate.example:4960')
  })

  it('serializes concurrent durable updates without losing either patch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-serialized-update-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41006', 100)
    const profile = await store.addRemote({
      displayName: '更新前',
      origin: 'serialized-update.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000015',
      pinnedSpkiSha256: 'spki-serialized',
    })

    await Promise.all([
      store.update(profile.id, { displayName: '更新后' }),
      store.update(profile.id, { notificationsEnabled: false }),
    ])
    const reopened = await InstanceProfileStore.open(file, 'http://127.0.0.1:41006', 200)
    expect(reopened.get(profile.id)).toMatchObject({ displayName: '更新后', notificationsEnabled: false })
  })

  it('updates reauthentication security without changing the Profile endpoint or identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-immutable-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41007', 100)
    const profile = await store.addRemote({
      displayName: '固定实例',
      origin: 'immutable-profile.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000017',
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
    })

    await store.updateRemoteSecurity(profile.id, {
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
    expect(store.get(profile.id)).toMatchObject({
      origin: 'https://immutable-profile.example:4960',
      observedInstanceId: 'nxt_instance_01H00000000000000000000017',
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
  })

  it('rolls back in-memory addition when the durable Profile write fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-write-failure-'))
    roots.push(root)
    const store = await InstanceProfileStore.open(path.join(root, 'profiles.json'), 'http://127.0.0.1:41008', 100)
    await rm(root, { recursive: true, force: true })

    await expect(
      store.addRemote({
        displayName: '无法保存',
        origin: 'write-failure.example',
        observedInstanceId: 'nxt_instance_01H00000000000000000000020',
        pinnedSpkiSha256: 'spki-write-failure',
      }),
    ).rejects.toThrow()
    expect(store.list().map(({ id }) => id)).toEqual(['local'])
  })

  it('updates a same-origin remote connection in place preserving id, identity and partition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-edit-same-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41010', 100)
    const instanceId = 'nxt_instance_01H00000000000000000000040'
    const profile = await store.addRemote({
      displayName: '旧名称',
      origin: 'edit-same.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
      now: 200,
    })
    const updated = await store.updateRemoteConnection(profile.id, {
      displayName: '新名称',
      origin: profile.origin,
      observedInstanceId: instanceId,
      ...(profile.transport === undefined ? {} : { transport: profile.transport }),
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
    expect(updated).toMatchObject({
      id: profile.id,
      displayName: '新名称',
      origin: profile.origin,
      observedInstanceId: instanceId,
      partition: profile.partition,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
    const reopened = await InstanceProfileStore.open(file, 'http://127.0.0.1:41010', 200)
    expect(reopened.get(profile.id)).toMatchObject({
      displayName: '新名称',
      partition: profile.partition,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
  })

  it('migrates a remote connection to a new address keeping its id and rotating the partition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-edit-migrate-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41011', 100)
    const instanceId = 'nxt_instance_01H00000000000000000000041'
    const profile = await store.addRemote({
      displayName: '旧地址',
      origin: 'old-home.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      credentialRef: 'old-credential',
      now: 200,
    })
    const updated = await store.updateRemoteConnection(profile.id, {
      displayName: '新地址',
      origin: 'new-home.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
    })
    expect(updated).toMatchObject({
      id: profile.id,
      displayName: '新地址',
      origin: 'https://new-home.example:4960',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'new-spki',
      credentialRef: 'new-credential',
      transport: 'auto-tls-pinned-v1',
    })
    expect(updated.partition).not.toBe(profile.partition)
    expect(updated.partition).toMatch(/^persist:nxt-instance-/u)
    const reopened = await InstanceProfileStore.open(file, 'http://127.0.0.1:41011', 200)
    expect(reopened.get(profile.id)).toMatchObject({
      id: profile.id,
      origin: 'https://new-home.example:4960',
      observedInstanceId: instanceId,
      partition: updated.partition,
    })
  })

  it('rejects connection updates conflicting with another Profile and excludes the current one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-edit-conflict-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41012', 100)
    const first = await store.addRemote({
      displayName: '甲',
      origin: 'first.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000042',
      pinnedSpkiSha256: 'spki-first',
      now: 200,
    })
    const second = await store.addRemote({
      displayName: '乙',
      origin: 'second.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000043',
      pinnedSpkiSha256: 'spki-second',
      now: 300,
    })
    await expect(
      store.updateRemoteConnection(second.id, {
        displayName: '撞地址',
        origin: first.origin,
        observedInstanceId: 'nxt_instance_01H00000000000000000000043',
        pinnedSpkiSha256: 'spki-second',
      }),
    ).rejects.toThrow('已经添加')
    await expect(
      store.updateRemoteConnection(second.id, {
        displayName: '撞身份',
        origin: 'own.example',
        observedInstanceId: 'nxt_instance_01H00000000000000000000042',
        pinnedSpkiSha256: 'spki-second',
      }),
    ).rejects.toThrow('已经添加')
    const migrated = await store.updateRemoteConnection(first.id, {
      displayName: '甲迁址',
      origin: 'relocated.example',
      observedInstanceId: 'nxt_instance_01H00000000000000000000042',
      pinnedSpkiSha256: 'spki-first-new',
    })
    expect(migrated).toMatchObject({
      id: first.id,
      displayName: '甲迁址',
      origin: 'https://relocated.example:4960',
      observedInstanceId: 'nxt_instance_01H00000000000000000000042',
    })
    expect(store.get(second.id)).toMatchObject({ origin: 'https://second.example:4960', displayName: '乙' })
  })

  it('rejects changing the instance identity or omitting the TLS pin on an HTTPS connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-edit-invariant-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41014', 100)
    const instanceId = 'nxt_instance_01H00000000000000000000045'
    const profile = await store.addRemote({
      displayName: '固定实例',
      origin: 'invariant.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'old-spki',
      now: 200,
    })
    await expect(
      store.updateRemoteConnection(profile.id, {
        displayName: '换身份',
        origin: profile.origin,
        observedInstanceId: 'nxt_instance_01H00000000000000000000046',
        pinnedSpkiSha256: 'old-spki',
      }),
    ).rejects.toThrow('身份不能修改')
    await expect(
      store.updateRemoteConnection(profile.id, {
        displayName: '无固定证书',
        origin: profile.origin,
        observedInstanceId: instanceId,
      }),
    ).rejects.toThrow('TLS 身份字段')
    expect(store.get(profile.id)).toMatchObject({ displayName: '固定实例', observedInstanceId: instanceId })
  })

  it('rolls back the in-memory connection update when the durable write fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-edit-write-failure-'))
    roots.push(root)
    const store = await InstanceProfileStore.open(path.join(root, 'profiles.json'), 'http://127.0.0.1:41015', 100)
    const instanceId = 'nxt_instance_01H00000000000000000000044'
    const profile = await store.addRemote({
      displayName: '保存前',
      origin: 'edit-failure.example',
      observedInstanceId: instanceId,
      pinnedSpkiSha256: 'spki-write-failure',
      now: 200,
    })
    await rm(root, { recursive: true, force: true })

    await expect(
      store.updateRemoteConnection(profile.id, {
        displayName: '保存后',
        origin: 'edit-failure.example',
        observedInstanceId: instanceId,
        pinnedSpkiSha256: 'spki-write-failure',
      }),
    ).rejects.toThrow()
    expect(store.get(profile.id)).toMatchObject({ displayName: '保存前', origin: 'https://edit-failure.example:4960' })
  })
})
