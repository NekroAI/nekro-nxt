import path from 'node:path'
import type { DesktopDistribution } from './distribution.js'

/**
 * Where the Desktop keeps its userData. `NEKRO_DESKTOP_USER_DATA` wins; otherwise a pointer file beside the default
 * location names the directory chosen in Settings → 存储; otherwise the default under the system app-data folder. The
 * pointer and the move record live outside every userData so that they survive moving it.
 */
export type UserDataSource = 'environment' | 'pointer' | 'default'

export interface UserDataResolution {
  readonly root: string
  readonly source: UserDataSource
  readonly defaultRoot: string
  /** Set when a pointer exists but cannot be read; the default is used and the problem is logged. */
  readonly pointerProblem?: string
}

export interface DataLocationFiles {
  /** `{ format, version, userData }`, replaced atomically when a move switches over. */
  readonly pointer: string
  /** The move record (`data-move.json` for the channel), read before anything opens userData. */
  readonly record: string
  /** The empty userData a migration-mode launch runs on, so the source has no open handles. */
  readonly migrationSession: string
}

export const dataLocationFiles = (appDataRoot: string, distribution: DesktopDistribution): DataLocationFiles => {
  const base = path.join(appDataRoot, distribution.appUserDataName)
  return {
    pointer: `${base}.data-location.json`,
    record: `${base}.data-move.json`,
    migrationSession: `${base}.data-move-session`,
  }
}

export const defaultUserDataRoot = (appDataRoot: string, distribution: DesktopDistribution): string =>
  path.join(appDataRoot, distribution.appUserDataName)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const parseDataLocationPointer = (text: string): string => {
  const value: unknown = JSON.parse(text)
  if (
    !isRecord(value) ||
    value['format'] !== 'nxt.desktop-data-location' ||
    value['version'] !== 1 ||
    typeof value['userData'] !== 'string' ||
    !path.isAbsolute(value['userData'])
  )
    throw new Error('Desktop data location pointer is invalid.')
  return path.normalize(value['userData'])
}

export const serializeDataLocationPointer = (userData: string): string =>
  `${JSON.stringify({ format: 'nxt.desktop-data-location', version: 1, userData: path.normalize(userData) }, null, 2)}\n`

/**
 * Resolves the userData root synchronously, before `app.setPath`. `readText` returns undefined when the file is
 * missing and throws for other read errors.
 */
export const resolveDesktopUserData = (input: {
  readonly appDataRoot: string
  readonly distribution: DesktopDistribution
  readonly override: string | undefined
  readonly readText: (file: string) => string | undefined
}): UserDataResolution => {
  const defaultRoot = defaultUserDataRoot(input.appDataRoot, input.distribution)
  if (input.override !== undefined && input.override.trim() !== '') {
    if (!path.isAbsolute(input.override)) throw new Error('NEKRO_DESKTOP_USER_DATA 必须是绝对路径。')
    return { root: input.override, source: 'environment', defaultRoot }
  }
  const files = dataLocationFiles(input.appDataRoot, input.distribution)
  try {
    const text = input.readText(files.pointer)
    if (text === undefined) return { root: defaultRoot, source: 'default', defaultRoot }
    return { root: parseDataLocationPointer(text), source: 'pointer', defaultRoot }
  } catch (error) {
    return {
      root: defaultRoot,
      source: 'default',
      defaultRoot,
      pointerProblem: error instanceof Error ? error.message : String(error),
    }
  }
}
