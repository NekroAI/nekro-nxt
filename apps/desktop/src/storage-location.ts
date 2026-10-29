import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Recognises directories that live on a network share or inside a cloud sync folder. A data directory there would be
 * read by the sync client while SQLite writes to it, or disappear when the share drops, so a move refuses them.
 * Everything platform-specific comes in through `StorageFacts` so the rules are testable on any OS.
 */
export type SyncProvider = 'onedrive' | 'dropbox' | 'icloud' | 'nutstore' | 'baidu' | 'cloud-storage'

export type StorageLocationKind =
  | { readonly kind: 'local' }
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'sync'; readonly provider: SyncProvider; readonly root: string }

export interface MountEntry {
  readonly mountPoint: string
  readonly type: string
}

export interface StorageFacts {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homedir: string
  /** Returns undefined for a missing or unreadable file. */
  readonly readText: (file: string) => Promise<string | undefined>
  /** Mounted file systems on macOS and Linux; empty when they cannot be listed. */
  readonly mounts: () => Promise<readonly MountEntry[]>
  /** `statfs` magic number of the nearest existing directory (Linux), or undefined. */
  readonly fileSystemType: (directory: string) => Promise<number | undefined>
  /** Windows drive type of a drive letter such as `Z:` (`Network`, `Fixed`, …), or undefined. */
  readonly windowsDriveType: (drive: string) => Promise<string | undefined>
}

const NETWORK_MOUNT_TYPES = new Set([
  'nfs',
  'nfs4',
  'smbfs',
  'smb',
  'smb2',
  'smb3',
  'cifs',
  'afpfs',
  'webdav',
  'davfs',
  'ftp',
  'sshfs',
  'fuse.sshfs',
  'fuse.rclone',
  'fuse.davfs',
  'fuse.s3fs',
  'fuse.gcsfuse',
  '9p',
  'ceph',
  'glusterfs',
  'fuse.glusterfs',
  'afs',
  'lustre',
])
/** Linux `statfs` magic numbers of network file systems: NFS, SMB, CIFS, SMB2, Coda, AFS, Ceph, 9P. */
const NETWORK_STATFS_MAGIC = new Set([
  0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x73757245, 0x5346414f, 0x00c36400, 0x01021997,
])

const windowsPath = path.win32
const posixPath = path.posix

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? windowsPath : posixPath)

/** Case-insensitive on Windows and macOS (their default file systems), exact elsewhere. */
export const isSameOrInside = (platform: NodeJS.Platform, parent: string, child: string): boolean => {
  const api = pathApi(platform)
  const fold = (value: string) => (platform === 'linux' ? value : value.toLowerCase())
  const relative = api.relative(fold(api.resolve(parent)), fold(api.resolve(child)))
  return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))
}

const isUncPath = (target: string): boolean => /^(\\\\|\/\/)(?!\?\\[a-z]:)(?!\.\\)/iu.test(target)

interface SyncRoot {
  readonly provider: SyncProvider
  readonly root: string
}

const parseDropboxInfo = (text: string | undefined): readonly string[] => {
  if (text === undefined) return []
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return []
    return Object.values(value).flatMap((account: unknown) =>
      typeof account === 'object' && account !== null && 'path' in account && typeof account.path === 'string'
        ? [account.path]
        : [],
    )
  } catch {
    return []
  }
}

/** Sync roots named by environment variables and client configuration files. */
const configuredSyncRoots = async (facts: StorageFacts): Promise<readonly SyncRoot[]> => {
  const api = pathApi(facts.platform)
  const roots: SyncRoot[] = []
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const value = facts.env[name]?.trim()
    if (value) roots.push({ provider: 'onedrive', root: value })
  }
  const dropboxInfo =
    facts.platform === 'win32'
      ? [facts.env['APPDATA'], facts.env['LOCALAPPDATA']]
          .filter((value): value is string => Boolean(value))
          .map((base) => api.join(base, 'Dropbox', 'info.json'))
      : [api.join(facts.homedir, '.dropbox', 'info.json')]
  for (const file of dropboxInfo)
    for (const root of parseDropboxInfo(await facts.readText(file))) roots.push({ provider: 'dropbox', root })
  if (facts.platform === 'darwin') {
    roots.push({ provider: 'icloud', root: api.join(facts.homedir, 'Library', 'Mobile Documents') })
    roots.push({ provider: 'cloud-storage', root: api.join(facts.homedir, 'Library', 'CloudStorage') })
  }
  if (facts.platform === 'win32') {
    const profile = facts.env['USERPROFILE']?.trim() || facts.homedir
    roots.push({ provider: 'icloud', root: api.join(profile, 'iCloudDrive') })
    roots.push({ provider: 'icloud', root: api.join(profile, 'iCloud Drive') })
  }
  return roots
}

/** Folder names the sync clients create by default; matched on any path segment. */
const SEGMENT_PATTERNS: readonly { readonly provider: SyncProvider; readonly pattern: RegExp }[] = [
  { provider: 'onedrive', pattern: /^OneDrive(?:$|[ -])/iu },
  { provider: 'dropbox', pattern: /^Dropbox(?:$| \()/iu },
  { provider: 'icloud', pattern: /^(?:iCloud ?Drive|Mobile Documents|com~apple~CloudDocs)$/iu },
  { provider: 'nutstore', pattern: /^(?:Nutstore(?: Files)?|我的坚果云|坚果云)$/iu },
  { provider: 'baidu', pattern: /^(?:BaiduSyncdisk|百度网盘同步空间|百度同步盘)$/iu },
]

const segmentSyncRoot = (platform: NodeJS.Platform, target: string): SyncRoot | undefined => {
  const api = pathApi(platform)
  const resolved = api.resolve(target)
  const { root } = api.parse(resolved)
  const segments = resolved.slice(root.length).split(api.sep).filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) {
    const match = SEGMENT_PATTERNS.find(({ pattern }) => pattern.test(segments[index]!))
    if (match) return { provider: match.provider, root: api.join(root, ...segments.slice(0, index + 1)) }
  }
  return undefined
}

const longestMount = (platform: NodeJS.Platform, mounts: readonly MountEntry[], target: string) =>
  mounts
    .filter((mount) => isSameOrInside(platform, mount.mountPoint, target))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0]

export const classifyStorageLocation = async (target: string, facts: StorageFacts): Promise<StorageLocationKind> => {
  const api = pathApi(facts.platform)
  if (facts.platform === 'win32') {
    if (isUncPath(target) || /^\\\\\?\\UNC\\/iu.test(target)) return { kind: 'network', detail: 'unc' }
    const drive = /^([a-z]):/iu.exec(api.resolve(target))?.[1]
    if (drive !== undefined && (await facts.windowsDriveType(`${drive.toUpperCase()}:`)) === 'Network')
      return { kind: 'network', detail: `drive ${drive.toUpperCase()}:` }
  } else {
    const mount = longestMount(facts.platform, await facts.mounts(), target)
    if (mount !== undefined && NETWORK_MOUNT_TYPES.has(mount.type.toLowerCase()))
      return { kind: 'network', detail: `${mount.type} ${mount.mountPoint}` }
    const magic = await facts.fileSystemType(target)
    if (magic !== undefined && NETWORK_STATFS_MAGIC.has(magic))
      return { kind: 'network', detail: `statfs 0x${magic.toString(16)}` }
  }
  for (const root of await configuredSyncRoots(facts))
    if (isSameOrInside(facts.platform, root.root, target)) return { kind: 'sync', ...root }
  const segment = segmentSyncRoot(facts.platform, target)
  if (segment !== undefined) return { kind: 'sync', ...segment }
  return { kind: 'local' }
}

/** `mount` on macOS prints `//user@server/share on /Volumes/<share> (smbfs, nodev, …)`. */
export const parseMacMounts = (text: string): readonly MountEntry[] =>
  text.split('\n').flatMap((line) => {
    const match = / on (.+) \(([^,)]+)/u.exec(line)
    return match ? [{ mountPoint: match[1]!, type: match[2]!.trim() }] : []
  })

/** `/proc/self/mounts`: device, mount point (octal-escaped), type, … */
export const parseLinuxMounts = (text: string): readonly MountEntry[] =>
  text.split('\n').flatMap((line) => {
    const [, mountPoint, type] = line.split(' ')
    if (!mountPoint || !type) return []
    return [
      {
        mountPoint: mountPoint.replace(/\\([0-7]{3})/gu, (_, code: string) => String.fromCharCode(parseInt(code, 8))),
        type,
      },
    ]
  })

const run = (file: string, args: readonly string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 5_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    )
  })

const nearestExisting = async (target: string): Promise<string> => {
  let current = path.resolve(target)
  for (;;) {
    try {
      await statfs(current)
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

export const systemStorageFacts = (): StorageFacts => ({
  platform: process.platform,
  env: process.env,
  homedir: os.homedir(),
  readText: async (file) => readFile(file, 'utf8').catch(() => undefined),
  mounts: async () => {
    if (process.platform === 'darwin') return parseMacMounts((await run('/sbin/mount', [])) ?? '')
    if (process.platform === 'linux')
      return parseLinuxMounts(await readFile('/proc/self/mounts', 'utf8').catch(() => ''))
    return []
  },
  fileSystemType: async (directory) => {
    if (process.platform !== 'linux') return undefined
    try {
      return (await statfs(await nearestExisting(directory))).type
    } catch {
      return undefined
    }
  },
  windowsDriveType: async (drive) =>
    (
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[System.IO.DriveInfo]::new('${drive.replace(/[^A-Za-z:]/gu, '')}').DriveType`,
      ])
    )?.trim() || undefined,
})
