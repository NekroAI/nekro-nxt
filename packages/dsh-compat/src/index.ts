import { createRequire } from 'node:module'

/** Exact DSH packages imported by the current production Client facade. */
export const DSH_PACKAGE_VERSIONS = {
  '@deepseek-ai/dsh-client-ui-slots': '0.1.0-rc.6',
} as const

export type DshPackageName = keyof typeof DSH_PACKAGE_VERSIONS

const isDshPackageName = (name: string): name is DshPackageName => name in DSH_PACKAGE_VERSIONS

const hasDshPackageVersions = (input: Record<string, string>): input is Record<DshPackageName, string> =>
  Object.keys(DSH_PACKAGE_VERSIONS).every((name) => typeof input[name] === 'string')

const parsePackageManifest = (input: unknown, name: string): { readonly version: string } => {
  if (typeof input !== 'object' || input === null || !('version' in input) || typeof input.version !== 'string') {
    throw new Error(`${name} does not expose a string version.`)
  }
  return { version: input.version }
}

/** Reads installed package metadata through each package's public package.json export. */
export function readInstalledDshVersions(): Readonly<Record<DshPackageName, string>> {
  const require = createRequire(import.meta.url)
  const entries = Object.keys(DSH_PACKAGE_VERSIONS)
    .filter(isDshPackageName)
    .map((name): readonly [DshPackageName, string] => {
      const manifest = parsePackageManifest(require(`${name}/package.json`), name)
      return [name, manifest.version]
    })
  const installed = Object.fromEntries(entries)
  if (!hasDshPackageVersions(installed)) throw new Error('Installed DSH package versions are incomplete.')
  return installed
}

/** Fails before Runtime composition when any DSH package drifts from the validated family. */
export function assertDshPackageVersions(): void {
  const installed = readInstalledDshVersions()
  for (const name of Object.keys(DSH_PACKAGE_VERSIONS).filter(isDshPackageName)) {
    const expected = DSH_PACKAGE_VERSIONS[name]
    const actual = installed[name]
    if (actual !== expected)
      throw new Error(`DSH package version mismatch: ${name} expected ${expected}, received ${actual}.`)
  }
}
