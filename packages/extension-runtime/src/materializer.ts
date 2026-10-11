import {
  extensionContributionSchema,
  extensionIconSchema,
  extensionManifestSchema,
  extensionProvides,
  normalizeSource,
  revisionDigests,
  revisionResourcesSchema,
  revisionSourcesSchema,
  validateRevisionResources,
  type MaterializedExtensionRevision,
} from '@nekro-nxt/extension-format'
import {
  ExtensionLayeredConfigSchema,
  ExtensionPermissionsSchema,
  type ExtensionId,
  type ExtensionRevisionId,
  EXTENSION_SDK_BASE_LEVEL,
  requiredExtensionSdkLevel,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { DynamicPackageSnapshot } from './types.js'

export { materializeImportedRevision } from '@nekro-nxt/extension-format'

const inputSchema = z
  .object({
    snapshot: z
      .object({
        name: z.string().trim().min(1).max(80),
        purpose: z.string().trim().min(1).max(500),
        hostCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        clientCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        permissions: ExtensionPermissionsSchema.optional(),
        resources: z
          .record(z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u), z.string().max(256 * 1024))
          .optional(),
        clientCss: z
          .object({
            path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict()
          .optional(),
        icon: extensionIconSchema.optional(),
        config: ExtensionLayeredConfigSchema.optional(),
        contributions: z.array(extensionContributionSchema).default([]),
      })
      .strict()
      .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
        message: 'A dynamic Package snapshot needs a Host or Client source half.',
      }),
  })
  .strict()

const wrapHost = (body: string): string =>
  normalizeSource(`import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness, nxt }) => {
${body}
})`)

const wrapClient = (body: string, clientCssPath?: string): string =>
  normalizeSource(`${clientCssPath === undefined ? '' : `import '../${clientCssPath}?nxt-dynamic-css'\n`}
import { defineClientExtension } from '@nekro-nxt/extension-sdk'

export default defineClientExtension(async ({ React, host, styles }) => {
${body}
})`)

/** Client CSS is scoped to this Revision's rendered UI, so it is only meaningful with a Client half. */
export const assertClientCssScope = (input: { readonly hasClientCss: boolean; readonly hasClient: boolean }): void => {
  if (input.hasClientCss && !input.hasClient) throw new Error('Client CSS 需要同时提交 Client 源码。')
}

export function materializeDynamicPackage(input: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly snapshot: DynamicPackageSnapshot
}): MaterializedExtensionRevision {
  const parsed = inputSchema.parse({
    snapshot: input.snapshot,
  })
  const contributions = parsed.snapshot.contributions
  assertClientCssScope({
    hasClientCss: parsed.snapshot.clientCss !== undefined,
    hasClient: parsed.snapshot.clientCode !== undefined,
  })
  const sources = revisionSourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined ? {} : { host: wrapHost(parsed.snapshot.hostCode) }),
    ...(parsed.snapshot.clientCode === undefined
      ? {}
      : { client: wrapClient(parsed.snapshot.clientCode, parsed.snapshot.clientCss?.path) }),
  })
  const permissions = parsed.snapshot.permissions ?? { permissions: [], networkOrigins: [] }
  // Agent-written extensions never state a level; record the one their capabilities need so an older NekroNXT that
  // imports the package asks for an upgrade.
  const required = requiredExtensionSdkLevel(permissions).level
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 7,
    extensionId: input.extensionId,
    revisionId: input.revisionId,
    ...(required > EXTENSION_SDK_BASE_LEVEL ? { requires: { sdk: required } } : {}),
    entrypoints: {
      ...('host' in sources ? { host: 'source/host.ts' } : {}),
      ...('client' in sources ? { client: 'source/client.ts' } : {}),
    },
    ...(parsed.snapshot.clientCss === undefined ? {} : { clientCss: parsed.snapshot.clientCss }),
    ...(parsed.snapshot.icon === undefined ? {} : { icon: parsed.snapshot.icon }),
    permissions,
    ...(parsed.snapshot.config === undefined ? {} : { config: parsed.snapshot.config }),
    contributions,
  })
  const resources = revisionResourcesSchema.parse(parsed.snapshot.resources ?? {})
  validateRevisionResources(manifest, resources, '动态扩展')
  return {
    manifest,
    sources,
    resources,
    ...revisionDigests({ manifest, sources, resources }),
    provides: extensionProvides(manifest),
  }
}
