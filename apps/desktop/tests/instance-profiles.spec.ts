import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceProfileStore, normalizeRemoteOrigin } from '../src/instance-profiles.ts'

const TEST_IP = [203, 0, 113, 8].join('.')

describe('Desktop instance profiles', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('normalizes only host addresses and supplies the secure default port', () => {
    expect(normalizeRemoteOrigin(TEST_IP)).toBe(`https://${TEST_IP}:4960`)
    expect(normalizeRemoteOrigin('home.example:7443')).toBe('https://home.example:7443')
    expect(() => normalizeRemoteOrigin('http://home.example')).toThrow('只能包含')
    expect(() => normalizeRemoteOrigin('home.example/path')).toThrow('不能包含路径')
    expect(() => normalizeRemoteOrigin('user:pass@home.example')).toThrow('只能包含')
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

  it('preserves a damaged future envelope as a recovery file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-instance-recovery-'))
    roots.push(root)
    const file = path.join(root, 'profiles.json')
    await writeFile(file, '{"format":"nxt.desktop-instance-profiles","version":99}', 'utf8')
    const store = await InstanceProfileStore.open(file, 'http://127.0.0.1:41001', 1234)
    expect(store.list()).toHaveLength(1)
    expect(await readFile(`${file}.recovery-1234`, 'utf8')).toContain('"version":99')
  })
})
