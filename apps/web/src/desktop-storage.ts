/**
 * Settings → 存储 talks to the Desktop main process through `window.nekroDesktopStorage`. The bridge exists only in the
 * Desktop app and answers only the local instance's own page; in a browser, or on a remote instance, the data directory
 * rows are hidden.
 */
export type DataMoveMethod = 'move' | 'copy'

export type DataMoveProblem =
  | { readonly code: 'not-absolute' }
  | { readonly code: 'same-directory' }
  | { readonly code: 'inside-source' }
  | { readonly code: 'contains-source' }
  | { readonly code: 'not-empty' }
  | { readonly code: 'not-directory' }
  | { readonly code: 'not-writable' }
  | { readonly code: 'network' }
  | {
      readonly code: 'sync'
      readonly provider: 'onedrive' | 'dropbox' | 'icloud' | 'nutstore' | 'baidu' | 'cloud-storage'
    }
  | { readonly code: 'insufficient-space'; readonly requiredBytes: number; readonly availableBytes: number }
  | { readonly code: 'path-too-long'; readonly longest: number }

export interface DesktopDataDirectoryStatus {
  readonly available: boolean
  readonly lockedBy?: 'environment'
  readonly path: string
  readonly oldDirectory?: { readonly path: string; readonly method: DataMoveMethod }
  readonly lastFailure?: { readonly message: string; readonly file?: string; readonly target: string }
}

export type DesktopDataDirectoryChoice =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly target: string; readonly problem: DataMoveProblem }
  | {
      readonly kind: 'ready'
      readonly target: string
      readonly method: DataMoveMethod
      readonly bytes: number
      readonly estimatedSeconds: number
    }

export interface DesktopStorageBridge {
  status(): Promise<
    { readonly supported: false } | { readonly supported: true; readonly status: DesktopDataDirectoryStatus }
  >
  sizes(): Promise<{ readonly current: number; readonly oldDirectory?: number }>
  chooseDirectory(): Promise<DesktopDataDirectoryChoice>
  startMove(target: string): Promise<DesktopDataDirectoryChoice>
  revealOldDirectory(): Promise<void>
  dismissNotice(): Promise<void>
}

declare global {
  interface Window {
    readonly nekroDesktopStorage?: DesktopStorageBridge
  }
}

export const desktopStorageBridge = (): DesktopStorageBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.nekroDesktopStorage

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export const formatDuration = (seconds: number): string =>
  seconds < 60
    ? '不到 1 分钟'
    : seconds < 3600
      ? `约 ${Math.ceil(seconds / 60)} 分钟`
      : `约 ${(seconds / 3600).toFixed(1)} 小时`

const SYNC_NAMES: Record<Extract<DataMoveProblem, { code: 'sync' }>['provider'], string> = {
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  icloud: 'iCloud 云盘',
  nutstore: '坚果云',
  baidu: '百度网盘',
  'cloud-storage': '云盘',
}

export const describeDataMoveProblem = (problem: DataMoveProblem): string => {
  switch (problem.code) {
    case 'not-absolute':
      return '请选择一个文件夹。'
    case 'same-directory':
      return '这就是当前的数据目录。'
    case 'inside-source':
      return '新目录不能在当前数据目录里面。'
    case 'contains-source':
      return '新目录不能包含当前数据目录。'
    case 'not-empty':
      return '请选择一个空文件夹。'
    case 'not-directory':
      return '这个位置不是文件夹。'
    case 'not-writable':
      return '无法写入这个文件夹，请检查权限，或确认磁盘已连接。'
    case 'network':
      return '数据目录不能放在网络盘上，请选择本机磁盘上的文件夹。'
    case 'sync':
      return `这个文件夹由${SYNC_NAMES[problem.provider]}同步，数据目录不能放在同步文件夹里。`
    case 'insufficient-space':
      return `磁盘空间不足：需要 ${formatBytes(problem.requiredBytes)}，可用 ${formatBytes(problem.availableBytes)}。`
    case 'path-too-long':
      return '这个位置的路径太长，请选择层级更浅的文件夹。'
  }
}
