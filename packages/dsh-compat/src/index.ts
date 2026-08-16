import { createRequire } from 'node:module'

/** Exact DSH packages imported by the current production Client facade. */
export const DSH_PACKAGE_VERSIONS = {
  '@deepseek-ai/dsh-client-ui-slots': '0.1.0-rc.6',
} as const

export type DshPackageName = keyof typeof DSH_PACKAGE_VERSIONS

/** Reads installed package metadata through each package's public package.json export. */
export function readInstalledDshVersions(): Readonly<Record<DshPackageName, string>> {
  const require = createRequire(import.meta.url)
  return Object.fromEntries(
    Object.keys(DSH_PACKAGE_VERSIONS).map((name) => {
      const manifest = require(`${name}/package.json`) as { readonly version?: unknown }
      if (typeof manifest.version !== 'string') throw new Error(`${name} does not expose a string version.`)
      return [name, manifest.version]
    }),
  ) as Record<DshPackageName, string>
}

/** Fails before Runtime composition when any DSH package drifts from the validated family. */
export function assertDshPackageVersions(): void {
  const installed = readInstalledDshVersions()
  for (const [name, expected] of Object.entries(DSH_PACKAGE_VERSIONS) as [DshPackageName, string][]) {
    const actual = installed[name]
    if (actual !== expected)
      throw new Error(`DSH package version mismatch: ${name} expected ${expected}, received ${actual}.`)
  }
}
