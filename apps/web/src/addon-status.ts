import type { AddonProviderStatus, AddonState, AddonStatus } from '@nekro-nxt/contracts'
import type { Tone } from './ui-kit/index.js'

export const addonUsable = (state: AddonState | undefined): boolean => state === 'installed' || state === 'available'

/** Label and tone of a capability or a provider; a failed one that has a source is installed but cannot start. */
export const addonStateLabel = (
  state: AddonState,
  progress?: AddonStatus['progress'],
  source?: AddonProviderStatus['source'],
): { readonly label: string; readonly tone: Tone } => {
  switch (state) {
    case 'installing':
      return {
        label:
          progress?.totalBytes === undefined || progress.totalBytes === 0
            ? '正在下载'
            : `正在下载 ${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%`,
        tone: 'accent',
      }
    case 'installed':
      return { label: '已安装', tone: 'ok' }
    case 'available':
      return { label: '可用', tone: 'ok' }
    case 'failed':
      return { label: source === undefined ? '安装失败' : '无法使用', tone: 'bad' }
    case 'unsupported':
      return { label: '这台设备不支持', tone: 'neutral' }
    case 'needs-config':
      return { label: '待配置', tone: 'warn' }
    case 'not-installed':
      return { label: '未安装', tone: 'neutral' }
  }
}
