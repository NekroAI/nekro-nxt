import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertWritableBackupStore,
  readUpgradeBackupPolicy,
  writeUpgradeBackupPolicy,
} from '../src/upgrade-backup-policy.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

describe('upgrade backup policy', () => {
  it('backs up into the data root unless the settings file or the environment says otherwise', async () => {
    const dataRoot = await temporary('nxt-backup-policy-')
    expect(await readUpgradeBackupPolicy(dataRoot, {})).toEqual({ policy: { mode: 'data' }, source: 'default' })

    const store = await temporary('nxt-backup-store-')
    await writeUpgradeBackupPolicy(dataRoot, { mode: 'directory', directory: store })
    expect(await readUpgradeBackupPolicy(dataRoot, {})).toEqual({
      policy: { mode: 'directory', directory: store },
      source: 'settings',
    })

    // Server deployments set it in the environment, which wins over the settings page.
    expect(await readUpgradeBackupPolicy(dataRoot, { NEKRO_UPGRADE_BACKUP: 'off' })).toEqual({
      policy: { mode: 'off' },
      source: 'environment',
    })
    expect(await readUpgradeBackupPolicy(dataRoot, { NEKRO_UPGRADE_BACKUP_DIR: '/mnt/backups' })).toEqual({
      policy: { mode: 'directory', directory: '/mnt/backups' },
      source: 'environment',
    })
  })

  it('falls back to the data root when the settings file is unreadable', async () => {
    const dataRoot = await temporary('nxt-backup-policy-')
    await mkdir(path.join(dataRoot, 'host'), { recursive: true })
    await writeFile(path.join(dataRoot, 'host', 'upgrade-backup.json'), '{ "mode": "elsewhere" }')
    expect(await readUpgradeBackupPolicy(dataRoot, {})).toEqual({ policy: { mode: 'data' }, source: 'default' })
  })

  it('accepts only absolute, writable directories outside the data root', async () => {
    const dataRoot = await temporary('nxt-backup-policy-')
    await expect(assertWritableBackupStore(dataRoot, 'relative/backups')).rejects.toThrow('绝对路径')
    await expect(assertWritableBackupStore(dataRoot, path.join(dataRoot, 'inside'))).rejects.toThrow('数据目录')
    const store = path.join(await temporary('nxt-backup-store-'), 'nested', 'backups')
    await assertWritableBackupStore(dataRoot, store)
  })
})
