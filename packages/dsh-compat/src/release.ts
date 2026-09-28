import manifest from './release.json' with { type: 'json' }

/** Product-owned compatibility axes: a release bump alone never authorizes a reset. */
export interface DshRuntimeRelease {
  readonly format: 'nxt.dsh-runtime-release'
  readonly version: 1
  readonly dshVersion: string
  readonly cordisVersion: string
  readonly loaderVersion: string
  readonly sessionCompatibilityId: string
  readonly settingsFormatVersion: number
  readonly extensionRuntimeAbi: string
  readonly packages: Readonly<Record<string, string>>
  readonly exceptions: Readonly<Record<string, string>>
}

export const DSH_RUNTIME_RELEASE: DshRuntimeRelease = Object.freeze({
  ...manifest,
  format: 'nxt.dsh-runtime-release',
  version: 1,
  packages: Object.freeze(manifest.packages),
  exceptions: Object.freeze(manifest.exceptions),
})

/** Stable and browser-safe; callers may hash this identity into their own artifact keys. */
export const runtimeFingerprint = (release: DshRuntimeRelease): string =>
  JSON.stringify([
    release.dshVersion,
    release.cordisVersion,
    release.loaderVersion,
    release.sessionCompatibilityId,
    release.settingsFormatVersion,
    release.extensionRuntimeAbi,
    Object.entries(release.packages).sort(([a], [b]) => a.localeCompare(b, 'en')),
  ])

export const DSH_RUNTIME_FINGERPRINT = runtimeFingerprint(DSH_RUNTIME_RELEASE)

export const expectedDshPackageVersion = (name: string): string | undefined =>
  DSH_RUNTIME_RELEASE.packages[name] ??
  DSH_RUNTIME_RELEASE.exceptions[name] ??
  (name.startsWith('@deepseek-ai/dsh-') ? DSH_RUNTIME_RELEASE.dshVersion : undefined)
