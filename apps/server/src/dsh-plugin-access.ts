import type { DshPluginPackageRecord } from '@nekro-nxt/contracts'
import { expectedDshPackageVersion } from '@nekro-nxt/dsh-compat/release'
import { EXTENSION_PRIVATE_SERVICE_KEYS } from './extension-context.js'

/**
 * Host services kept off user-installed DSH plugins. `skills` is open to every installed plugin: Skill providers
 * contribute to the host registry instead of mounting a second one.
 */
export const DSH_PLUGIN_ISOLATED_SERVICE_KEYS: readonly string[] = EXTENSION_PRIVATE_SERVICE_KEYS.filter(
  (key) => key !== 'skills',
)
const ISOLATED_SET = new Set(DSH_PLUGIN_ISOLATED_SERVICE_KEYS)

const OFFICIAL_SCOPE = '@deepseek-ai/'
// pnpm verifies the registry tarball against this digest before it lands in the store.
const REGISTRY_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u

/**
 * An official plugin comes from the DSH maintainers through the npm registry and belongs to the DSH release this
 * build runs. An uploaded or imported tarball never qualifies, even under the same name.
 */
export const isOfficialDshPluginPackage = (
  record: Pick<DshPluginPackageRecord, 'packageName' | 'packageVersion' | 'source' | 'integrity'>,
): boolean =>
  record.packageName.startsWith(OFFICIAL_SCOPE) &&
  record.source === 'registry' &&
  expectedDshPackageVersion(record.packageName) === record.packageVersion &&
  record.integrity !== undefined &&
  REGISTRY_INTEGRITY.test(record.integrity)

export interface DshPluginServiceAccess {
  readonly official: boolean
  /** Host services this entry sees only because it is official and declared them. */
  readonly granted: readonly string[]
  /** Host services hidden from this entry. */
  readonly isolated: readonly string[]
}

/** Official plugins receive the host services they declare in `inject`; everything else stays isolated. */
export const dshPluginServiceAccess = (
  record: Pick<DshPluginPackageRecord, 'packageName' | 'packageVersion' | 'source' | 'integrity'>,
  declaredInject: readonly string[],
): DshPluginServiceAccess => {
  if (!isOfficialDshPluginPackage(record)) {
    return { official: false, granted: [], isolated: DSH_PLUGIN_ISOLATED_SERVICE_KEYS }
  }
  const declared = new Set(declaredInject)
  return {
    official: true,
    granted: [...declared].filter((key) => ISOLATED_SET.has(key)).sort(),
    isolated: DSH_PLUGIN_ISOLATED_SERVICE_KEYS.filter((key) => !declared.has(key)),
  }
}
