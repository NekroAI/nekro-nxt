import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { prepareUpgradeBackupStore, writeUpgradeJson } from './upgrade-backup.js'

/**
 * Whether and where the Host takes a restore point before upgrading. It is read before any storage owner opens, so it
 * lives in a small file in the data root rather than in the Core database. `NEKRO_UPGRADE_BACKUP=off` and
 * `NEKRO_UPGRADE_BACKUP_DIR` override the file, for server deployments configured through the environment.
 */
export const UpgradeBackupPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('data') }).strict(),
  z.object({ mode: z.literal('directory'), directory: z.string().min(1).max(1024) }).strict(),
  z.object({ mode: z.literal('off') }).strict(),
])
export type UpgradeBackupPolicy = z.output<typeof UpgradeBackupPolicySchema>

const settingsFile = (dataRoot: string): string => path.join(dataRoot, 'host', 'upgrade-backup.json')

export interface ResolvedUpgradeBackupPolicy {
  readonly policy: UpgradeBackupPolicy
  /** `environment` cannot be changed from the settings page. */
  readonly source: 'default' | 'settings' | 'environment'
}

export const readUpgradeBackupPolicy = async (
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUpgradeBackupPolicy> => {
  const switchValue = env['NEKRO_UPGRADE_BACKUP']?.trim().toLowerCase()
  if (switchValue === 'off') return { policy: { mode: 'off' }, source: 'environment' }
  const directory = env['NEKRO_UPGRADE_BACKUP_DIR']?.trim()
  if (directory) return { policy: { mode: 'directory', directory }, source: 'environment' }
  try {
    const policy = UpgradeBackupPolicySchema.parse(JSON.parse(await readFile(settingsFile(dataRoot), 'utf8')))
    return { policy, source: 'settings' }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.error('[nekro-nxt] 升级前备份设置无法读取，按默认在数据目录中备份：', error)
    }
    return { policy: { mode: 'data' }, source: 'default' }
  }
}

export const writeUpgradeBackupPolicy = (dataRoot: string, policy: UpgradeBackupPolicy): Promise<void> =>
  writeUpgradeJson(settingsFile(dataRoot), UpgradeBackupPolicySchema.parse(policy))

/** The store directory a policy names, or undefined for the data root's own `backups/`. */
export const upgradeBackupStore = (policy: UpgradeBackupPolicy): string | undefined =>
  policy.mode === 'directory' ? policy.directory : undefined

/** A directory the settings page may choose: absolute, outside the data root and writable now. */
export const assertWritableBackupStore = async (dataRoot: string, directory: string): Promise<void> => {
  const store = await prepareUpgradeBackupStore(dataRoot, directory)
  const probe = path.join(store, `.nekro-nxt-write-check-${randomUUID()}`)
  try {
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
  } catch {
    throw new Error('无法写入这个位置，请检查目录权限或外置盘是否已连接。')
  } finally {
    await rm(probe, { force: true })
  }
}
