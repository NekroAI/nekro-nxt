import { readFileSync } from 'node:fs'

export const DSH_RUNTIME_RELEASE = JSON.parse(
  readFileSync(new URL('../../packages/dsh-compat/src/release.json', import.meta.url), 'utf8'),
)
export const DSH_RELEASE_VERSION = DSH_RUNTIME_RELEASE.dshVersion
export const DSH_CORDIS_VERSION = DSH_RUNTIME_RELEASE.cordisVersion
export const DSH_LOADER_VERSION = DSH_RUNTIME_RELEASE.loaderVersion
export const DSH_RELEASE_EXCEPTIONS = new Map(Object.entries(DSH_RUNTIME_RELEASE.exceptions))

export const expectedDshVersion = (packageName) =>
  DSH_RUNTIME_RELEASE.packages[packageName] ??
  DSH_RELEASE_EXCEPTIONS.get(packageName) ??
  (packageName.startsWith('@deepseek-ai/dsh-') ? DSH_RELEASE_VERSION : undefined)
