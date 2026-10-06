import {
  configSecretKeys,
  EMPTY_CONFIG_SCHEMA,
  extensionCapabilitiesExpand,
  HostUiPermissionDeclarationSchema,
  type ExtensionCapabilities,
  parseConfigValue,
  validateConfigValue,
  type HostUiPermissionDeclaration,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import type { ExtensionManifest } from './manifest.js'
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

/** Validates a configuration value against the Manifest config schema and fills its defaults. */
export const resolveExtensionConfig = (manifest: ExtensionManifest | undefined, value: JsonValue | undefined) => {
  const schema = manifest?.config?.schema ?? EMPTY_CONFIG_SCHEMA
  const secrets = configSecretKeys(schema)
  return { ...parseConfigValue(schema, value ?? {}, { skipKeys: secrets }), ...secretReferences(secrets, value) }
}

/** Keeps a previous configuration when it is still valid for the new Revision, otherwise falls back to defaults. */
export const carryExtensionConfig = (manifest: ExtensionManifest | undefined, previous: JsonValue | undefined) => {
  const schema = manifest?.config?.schema ?? EMPTY_CONFIG_SCHEMA
  const secrets = configSecretKeys(schema)
  const carried = validateConfigValue(schema, previous ?? {}, { skipKeys: secrets })
  const base = carried.issues.length === 0 ? carried.value : parseConfigValue(schema, {}, { skipKeys: secrets })
  return { ...base, ...secretReferences(secrets, previous) }
}

export const activationOwnerKey = (agentId: string, extensionId: string): string =>
  `activation:${agentId}:${extensionId}`
