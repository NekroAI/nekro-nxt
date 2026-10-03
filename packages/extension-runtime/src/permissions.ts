import {
  EMPTY_CONFIG_SCHEMA,
  HostUiPermissionDeclarationSchema,
  parseConfigValue,
  validateConfigValue,
  type HostUiPermissionDeclaration,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import type { ExtensionManifest } from './manifest.js'
import type { HostUiPermissionGrant } from './types.js'

export const canonicalPermissionDeclaration = (input: unknown): HostUiPermissionDeclaration => {
  const parsed = HostUiPermissionDeclarationSchema.parse(input)
  return {
    permissions: [...parsed.permissions].sort(),
    networkOrigins: [...parsed.networkOrigins].sort(),
  }
}

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
    declaration.networkOrigins.some((origin) => !currentOrigins.has(origin))
  return {
    declaration,
    permissionDigest,
    approvalRequired:
      declaration.permissions.length > 0 || declaration.networkOrigins.length > 0
        ? current === undefined || expandsGrant
        : false,
  }
}

export const permissionApprovalError = (requirement: PermissionRequirement): Error =>
  new Error(`permission-approval-required:${requirement.permissionDigest}`)

/** Validates a configuration value against the Manifest config schema and fills its defaults. */
export const resolveExtensionConfig = (manifest: ExtensionManifest | undefined, value: JsonValue | undefined) =>
  parseConfigValue(manifest?.config?.schema ?? EMPTY_CONFIG_SCHEMA, value ?? {})

/** Keeps a previous configuration when it is still valid for the new Revision, otherwise falls back to defaults. */
export const carryExtensionConfig = (manifest: ExtensionManifest | undefined, previous: JsonValue | undefined) => {
  const schema = manifest?.config?.schema ?? EMPTY_CONFIG_SCHEMA
  const carried = validateConfigValue(schema, previous ?? {})
  return carried.issues.length === 0 ? carried.value : parseConfigValue(schema, {})
}

export const activationOwnerKey = (agentId: string, extensionId: string): string =>
  `activation:${agentId}:${extensionId}`
