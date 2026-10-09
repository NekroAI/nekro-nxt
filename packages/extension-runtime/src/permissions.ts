import {
  agentPermissionDeclaration,
  configSecretKeys,
  extensionCapabilitiesExpand,
  hostPermissionDeclaration,
  type ExtensionConfigLayer,
  HostUiPermissionDeclarationSchema,
  type ExtensionCapabilities,
  parseConfigValue,
  validateConfigValue,
  type HostUiPermissionDeclaration,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { layerConfigSchema, type ExtensionManifest } from '@nekro-nxt/extension-format'
import type { HostUiPermissionGrant } from './types.js'

const sorted = <Value extends string>(values: readonly Value[]): Value[] => [...values].sort()

/** Order-insensitive form so reordering a declaration never changes its approval digest. */
const canonicalCapabilities = (capabilities: ExtensionCapabilities): ExtensionCapabilities => {
  const network = capabilities.network
  return {
    ...(network === undefined
      ? {}
      : {
          network:
            network.mode === 'domains'
              ? { mode: 'domains', domains: sorted(network.domains) }
              : network.mode === 'config'
                ? { mode: 'config', fields: sorted(network.fields) }
                : network,
        }),
    ...(capabilities.storage === undefined
      ? {}
      : {
          storage: {
            scopes: sorted(capabilities.storage.scopes),
            ...(capabilities.storage.quotaBytes === undefined ? {} : { quotaBytes: capabilities.storage.quotaBytes }),
          },
        }),
    ...(capabilities.assets === undefined ? {} : { assets: capabilities.assets }),
    ...(capabilities.history === undefined ? {} : { history: capabilities.history }),
    ...(capabilities.llm === undefined ? {} : { llm: capabilities.llm }),
    ...(capabilities.platform === undefined
      ? {}
      : {
          platform: {
            actions: [...capabilities.platform.actions].sort((left, right) =>
              `${left.adapter}:${left.action}`.localeCompare(`${right.adapter}:${right.action}`),
            ),
            raw: sorted(capabilities.platform.raw),
          },
        }),
    ...(capabilities.inboundHook === undefined ? {} : { inboundHook: capabilities.inboundHook }),
    ...(capabilities.mcp === undefined
      ? {}
      : {
          mcp: {
            servers: [...capabilities.mcp.servers].sort((left, right) => left.name.localeCompare(right.name)),
          },
        }),
    ...(capabilities.jobs === undefined
      ? {}
      : {
          jobs: {
            ...(capabilities.jobs.declared === undefined
              ? {}
              : { declared: [...capabilities.jobs.declared].sort((left, right) => left.id.localeCompare(right.id)) }),
            ...(capabilities.jobs.runtime === undefined ? {} : { runtime: capabilities.jobs.runtime }),
          },
        }),
    ...(capabilities.context === undefined
      ? {}
      : { context: [...capabilities.context].sort((left, right) => left.name.localeCompare(right.name)) }),
  }
}

export const canonicalPermissionDeclaration = (input: unknown): HostUiPermissionDeclaration => {
  const parsed = HostUiPermissionDeclarationSchema.parse(input)
  return {
    permissions: sorted(parsed.permissions),
    networkOrigins: sorted(parsed.networkOrigins),
    ...(parsed.capabilities === undefined ? {} : { capabilities: canonicalCapabilities(parsed.capabilities) }),
  }
}

const declaresCapabilities = (declaration: HostUiPermissionDeclaration): boolean =>
  declaration.capabilities !== undefined && Object.keys(declaration.capabilities).length > 0

export const hostUiPermissionDigest = (input: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalPermissionDeclaration(input)))
    .digest('hex')

export interface PermissionRequirement {
  readonly declaration: HostUiPermissionDeclaration
  readonly permissionDigest: string
  readonly approvalRequired: boolean
}

/** A grant only needs re-approval when the declaration asks for something the current grant does not cover. */
export const permissionRequirement = (
  declarationInput: unknown,
  current: HostUiPermissionGrant | undefined,
): PermissionRequirement => {
  const declaration = canonicalPermissionDeclaration(declarationInput ?? { permissions: [], networkOrigins: [] })
  const permissionDigest = hostUiPermissionDigest(declaration)
  const currentPermissions = new Set(current?.declaration.permissions ?? [])
  const currentOrigins = new Set(current?.declaration.networkOrigins ?? [])
  const expandsGrant =
    declaration.permissions.some((permission) => !currentPermissions.has(permission)) ||
    declaration.networkOrigins.some((origin) => !currentOrigins.has(origin)) ||
    extensionCapabilitiesExpand(current?.declaration.capabilities, declaration.capabilities)
  return {
    declaration,
    permissionDigest,
    approvalRequired:
      declaration.permissions.length > 0 || declaration.networkOrigins.length > 0 || declaresCapabilities(declaration)
        ? current === undefined || expandsGrant
        : false,
  }
}

export const permissionApprovalError = (requirement: PermissionRequirement): Error =>
  new Error(`permission-approval-required:${requirement.permissionDigest}`)

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

/**
 * Secret fields hold opaque credential references written by the Host, never user-typed values, so they skip
 * schema validation and are carried verbatim; a missing secret is reported by the extension when it reads it.
 */
const secretReferences = (
  keys: readonly string[],
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> => {
  const record = asRecord(value)
  return Object.fromEntries(
    keys.flatMap((key) => {
      const reference = record[key]
      return typeof reference === 'string' && reference.length > 0 ? [[key, reference] as const] : []
    }),
  )
}

/** Skipped schema keys must also leave the value, or validation reports them as unknown fields. */
const withoutKeys = (value: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined => {
  // A non-object value is left as is so validation still reports it.
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

/** Validates a configuration value against one layer's config schema and fills its defaults. */
export const resolveExtensionConfig = (
  manifest: ExtensionManifest | undefined,
  layer: ExtensionConfigLayer,
  value: JsonValue | undefined,
) => {
  const schema = layerConfigSchema(manifest, layer)
  const secrets = configSecretKeys(schema)
  return {
    ...parseConfigValue(schema, withoutKeys(value, secrets) ?? {}, { skipKeys: secrets }),
    ...secretReferences(secrets, value),
  }
}

/** Keeps a previous configuration when it is still valid for the new Revision, otherwise falls back to defaults. */
export const carryExtensionConfig = (
  manifest: ExtensionManifest | undefined,
  layer: ExtensionConfigLayer,
  previous: JsonValue | undefined,
) => {
  const schema = layerConfigSchema(manifest, layer)
  const secrets = configSecretKeys(schema)
  const carried = validateConfigValue(schema, withoutKeys(previous, secrets) ?? {}, { skipKeys: secrets })
  const base = carried.issues.length === 0 ? carried.value : parseConfigValue(schema, {}, { skipKeys: secrets })
  return { ...base, ...secretReferences(secrets, previous) }
}

/** Credential references a configuration of one layer holds; deleted once nothing references them. */
export const configSecretReferences = (
  manifest: ExtensionManifest | undefined,
  layer: ExtensionConfigLayer,
  value: JsonValue | undefined,
): readonly string[] =>
  Object.values(secretReferences(configSecretKeys(layerConfigSchema(manifest, layer)), value)).flatMap((reference) =>
    typeof reference === 'string' ? [reference] : [],
  )

/** What installing this Revision on the machine asks the user to approve, against the current host grant. */
export const hostPermissionRequirement = (
  manifest: ExtensionManifest | undefined,
  current: HostUiPermissionGrant | undefined,
): PermissionRequirement =>
  permissionRequirement(manifest === undefined ? undefined : hostPermissionDeclaration(manifest.permissions), current)

/** What enabling this Revision for one agent asks the user to approve, against that agent's current grant. */
export const agentPermissionRequirement = (
  manifest: ExtensionManifest | undefined,
  current: HostUiPermissionGrant | undefined,
): PermissionRequirement =>
  permissionRequirement(manifest === undefined ? undefined : agentPermissionDeclaration(manifest.permissions), current)

export const extensionOwnerKey = (extensionId: string): string => `extension:${extensionId}`

export const activationOwnerKey = (agentId: string, extensionId: string): string =>
  `activation:${agentId}:${extensionId}`
