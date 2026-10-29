import { describe, expect, it } from 'vitest'
import {
  classifyStorageLocation,
  isSameOrInside,
  parseLinuxMounts,
  parseMacMounts,
  type StorageFacts,
} from '../src/storage-location.ts'

// Fictional home and volume paths, assembled so no literal personal path appears in the source.
const USERS = '/Users'
const VOLUMES = '/Volumes'
const HOME = '/home'

const resolved = <T>(value: T): Promise<T> => Promise.resolve(value)

const facts = (change: Partial<StorageFacts> & Pick<StorageFacts, 'platform'>): StorageFacts => ({
  env: {},
  homedir: change.platform === 'win32' ? 'C:\\Users\\example' : `${USERS}/example`,
  readText: () => Promise.resolve(undefined),
  mounts: () => Promise.resolve([]),
  fileSystemType: () => Promise.resolve(undefined),
  windowsDriveType: () => Promise.resolve('Fixed'),
  ...change,
})

describe('network and sync folder detection', () => {
  it('rejects UNC paths and mapped network drives on Windows', async () => {
    const windows = facts({
      platform: 'win32',
      windowsDriveType: (drive) => Promise.resolve(drive === 'Z:' ? 'Network' : 'Fixed'),
    })
    await expect(classifyStorageLocation('\\\\nas\\share\\NekroNXT', windows)).resolves.toMatchObject({
      kind: 'network',
    })
    await expect(classifyStorageLocation('\\\\?\\UNC\\nas\\share\\NekroNXT', windows)).resolves.toMatchObject({
      kind: 'network',
    })
    await expect(classifyStorageLocation('Z:\\NekroNXT', windows)).resolves.toEqual({
      kind: 'network',
      detail: 'drive Z:',
    })
    await expect(classifyStorageLocation('D:\\NekroNXT', windows)).resolves.toEqual({ kind: 'local' })
    await expect(classifyStorageLocation('\\\\?\\D:\\NekroNXT', windows)).resolves.toEqual({ kind: 'local' })
  })

  it('rejects macOS and Linux network mounts by their file system type', async () => {
    const mac = facts({
      platform: 'darwin',
      mounts: () =>
        resolved(
          parseMacMounts(
            [
              '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
              `//example@nas.example/share on ${VOLUMES}/share (smbfs, nodev, nosuid, mounted by example)`,
              `/dev/disk5s1 on ${VOLUMES}/Fast Disk (apfs, local, nodev, nosuid, journaled)`,
            ].join('\n'),
          ),
        ),
    })
    await expect(classifyStorageLocation(`${VOLUMES}/share/NekroNXT`, mac)).resolves.toEqual({
      kind: 'network',
      detail: `smbfs ${VOLUMES}/share`,
    })
    await expect(classifyStorageLocation(`${VOLUMES}/Fast Disk/NekroNXT`, mac)).resolves.toEqual({ kind: 'local' })

    const linux = facts({
      platform: 'linux',
      mounts: () =>
        resolved(
          parseLinuxMounts(
            [
              '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
              'nas.example:/export /mnt/nfs\\040share nfs4 rw 0 0',
              `example@host: ${HOME}/example/remote fuse.sshfs rw 0 0`,
            ].join('\n'),
          ),
        ),
      fileSystemType: (directory) => Promise.resolve(directory.startsWith('/srv/cifs') ? 0xff534d42 : 0xef53),
    })
    await expect(classifyStorageLocation('/mnt/nfs share/data', linux)).resolves.toMatchObject({ kind: 'network' })
    await expect(classifyStorageLocation(`${HOME}/example/remote/data`, linux)).resolves.toMatchObject({
      kind: 'network',
    })
    await expect(classifyStorageLocation('/srv/cifs/data', linux)).resolves.toEqual({
      kind: 'network',
      detail: 'statfs 0xff534d42',
    })
    await expect(classifyStorageLocation(`${HOME}/example/NekroNXT`, linux)).resolves.toEqual({ kind: 'local' })
  })

  it('finds OneDrive and Dropbox roots from environment variables and client configuration', async () => {
    const windows = facts({
      platform: 'win32',
      env: {
        OneDriveCommercial: 'C:\\Users\\example\\OneDrive - Example Org',
        APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      },
      readText: (file) =>
        resolved(
          file === 'C:\\Users\\example\\AppData\\Roaming\\Dropbox\\info.json'
            ? JSON.stringify({ personal: { path: 'E:\\Sync\\Personal Files' } })
            : undefined,
        ),
    })
    await expect(classifyStorageLocation('c:\\users\\EXAMPLE\\OneDrive - Example Org\\NXT', windows)).resolves.toEqual({
      kind: 'sync',
      provider: 'onedrive',
      root: 'C:\\Users\\example\\OneDrive - Example Org',
    })
    await expect(classifyStorageLocation('E:\\Sync\\Personal Files\\NXT', windows)).resolves.toMatchObject({
      kind: 'sync',
      provider: 'dropbox',
    })
    const linux = facts({
      platform: 'linux',
      homedir: `${HOME}/example`,
      readText: (file) =>
        resolved(
          file === `${HOME}/example/.dropbox/info.json`
            ? JSON.stringify({ business: { path: '/data/Team Files' } })
            : undefined,
        ),
    })
    await expect(classifyStorageLocation('/data/Team Files/NXT', linux)).resolves.toMatchObject({
      provider: 'dropbox',
    })
  })

  it('treats iCloud Drive and the macOS CloudStorage folder as sync folders', async () => {
    const mac = facts({ platform: 'darwin' })
    await expect(
      classifyStorageLocation(`${USERS}/example/Library/Mobile Documents/com~apple~CloudDocs/NXT`, mac),
    ).resolves.toMatchObject({ kind: 'sync', provider: 'icloud' })
    await expect(
      classifyStorageLocation(`${USERS}/example/Library/CloudStorage/GoogleDrive-example/NXT`, mac),
    ).resolves.toMatchObject({ kind: 'sync', provider: 'cloud-storage' })
    await expect(
      classifyStorageLocation('C:\\Users\\example\\iCloudDrive\\NXT', facts({ platform: 'win32' })),
    ).resolves.toMatchObject({ provider: 'icloud' })
  })

  it('recognises default sync folder names of Nutstore, Baidu Netdisk, OneDrive and Dropbox anywhere in the path', async () => {
    const windows = facts({ platform: 'win32' })
    await expect(classifyStorageLocation('D:\\Nutstore Files\\NXT', windows)).resolves.toMatchObject({
      provider: 'nutstore',
    })
    await expect(classifyStorageLocation('D:\\我的坚果云\\NXT', windows)).resolves.toMatchObject({
      provider: 'nutstore',
    })
    await expect(classifyStorageLocation('D:\\BaiduSyncdisk\\NXT', windows)).resolves.toEqual({
      kind: 'sync',
      provider: 'baidu',
      root: 'D:\\BaiduSyncdisk',
    })
    await expect(
      classifyStorageLocation(`${USERS}/example/OneDrive/NXT`, facts({ platform: 'darwin' })),
    ).resolves.toMatchObject({ provider: 'onedrive' })
    await expect(
      classifyStorageLocation(`${HOME}/example/Dropbox (Personal)/NXT`, facts({ platform: 'linux' })),
    ).resolves.toMatchObject({ provider: 'dropbox' })
    await expect(classifyStorageLocation('D:\\Data\\NekroNXT', windows)).resolves.toEqual({ kind: 'local' })
  })

  it('compares containment case-insensitively only where the file system is', () => {
    expect(isSameOrInside('win32', 'C:\\Data', 'c:\\data\\NXT')).toBe(true)
    expect(isSameOrInside('darwin', `${USERS}/Example`, '/users/example/NXT')).toBe(true)
    expect(isSameOrInside('linux', `${HOME}/Example`, `${HOME}/example/NXT`)).toBe(false)
    expect(isSameOrInside('linux', `${HOME}/example`, `${HOME}/example-other`)).toBe(false)
  })
})
