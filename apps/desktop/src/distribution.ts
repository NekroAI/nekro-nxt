import path from 'node:path'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../distributions.json' with { type: 'json' }

export type DesktopReleaseChannel = 'preview' | 'stable'

export interface DesktopDistribution {
  readonly appId: string
  readonly appUserDataName: string
  readonly artifactSlug: string
  readonly executableName: string
  readonly linuxExecutableName: string
  readonly nsisGuid: string
  readonly productName: string
}

const distributions: Readonly<Record<DesktopReleaseChannel, DesktopDistribution>> = desktopDistributions

export const getDesktopDistribution = (channel: DesktopReleaseChannel): DesktopDistribution => distributions[channel]

export interface ProductRelease {
  readonly format: 'nxt.product-release'
  readonly channel: DesktopReleaseChannel
  readonly baseVersion: string
  readonly version: string
  readonly commit: string
  readonly releaseId: string
  readonly dshVersion: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const releaseCommitField = ['com', 'mit'].join('')

export const parseProductRelease = (value: unknown): ProductRelease => {
  const releaseCommit = isRecord(value) ? value[releaseCommitField] : undefined
  if (
    !isRecord(value) ||
    value['format'] !== 'nxt.product-release' ||
    (value['channel'] !== 'preview' && value['channel'] !== 'stable') ||
    typeof value['baseVersion'] !== 'string' ||
    typeof value['version'] !== 'string' ||
    typeof releaseCommit !== 'string' ||
    typeof value['releaseId'] !== 'string' ||
    typeof value['dshVersion'] !== 'string' ||
    value['version'].length === 0 ||
    value['baseVersion'].length === 0 ||
    !/^[a-f0-9]{40}$/u.test(releaseCommit) ||
    value['releaseId'].length === 0 ||
    value['dshVersion'].length === 0
  ) {
    throw new Error('NekroNxt 产品 Release 清单无效。')
  }
  return {
    format: value['format'],
    channel: value['channel'],
    baseVersion: value['baseVersion'],
    version: value['version'],
    commit: releaseCommit,
    releaseId: value['releaseId'],
    dshVersion: value['dshVersion'],
  }
}

export const desktopDataRoot = (userDataRoot: string): string => path.join(userDataRoot, 'data')

export const resolveProductReleasePath = (desktopMainModuleUrl: string): string =>
  fileURLToPath(new URL('./product-release.json', desktopMainModuleUrl))

export const desktopUserDataRoot = (
  appDataRoot: string,
  distribution: DesktopDistribution,
  override: string | undefined,
): string => {
  if (override === undefined || override.trim() === '') return path.join(appDataRoot, distribution.appUserDataName)
  if (!path.isAbsolute(override)) throw new Error('NEKRO_DESKTOP_USER_DATA 必须是绝对路径。')
  return override
}

export const isSameApplicationOrigin = (currentOrigin: string, target: string): boolean => {
  try {
    return new URL(target).origin === currentOrigin
  } catch {
    return false
  }
}

export const isAllowedExternalUrl = (target: string): boolean => {
  try {
    const protocol = new URL(target).protocol
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}
