import {
  extensionContributionSchema,
  extensionIconSchema,
  assertAgentAuthoredConfig,
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
  EXTENSION_GOVERNANCE_SDK_LEVEL,
  EXTENSION_SDK_BASE_LEVEL,
  EXTENSION_SDK_LEVEL,
  requiredExtensionSdkLevel,
} from '@nekro-nxt/contracts'
import type { ExtensionLineage, ExtensionManifest } from '@nekro-nxt/extension-format'
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
        dataVersion: z.number().int().min(1).max(1_000_000).optional(),
        codeFormat: z.enum(['body', 'module']).optional(),
      })
      .strict()
      .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
        message: 'A dynamic Package snapshot needs a Host or Client source half.',
      }),
  })
  .strict()

const HOST_HEADER = `import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness, nxt, logger }) => {
`
const CLIENT_HEADER = `import { defineClientExtension } from '@nekro-nxt/extension-sdk'

export default defineClientExtension(async ({ React, host, styles }) => {
`
const FOOTER = '\n})\n'
const cssImport = (clientCssPath: string) => `import '../${clientCssPath}?nxt-dynamic-css'\n`

const wrapHost = (body: string): string => normalizeSource(`${HOST_HEADER}${body}\n})`)

const wrapClient = (body: string, clientCssPath?: string): string =>
  normalizeSource(`${clientCssPath === undefined ? '' : `${cssImport(clientCssPath)}\n`}${CLIENT_HEADER}${body}\n})`)

/** Middle of `source` when it is exactly `header` + body + footer, as the save wrapper writes it. */
const unwrap = (source: string, header: string): string | undefined =>
  source.startsWith(header) && source.endsWith(FOOTER) ? source.slice(header.length, -FOOTER.length) : undefined

/**
 * Source of a stored Revision in the form a creation task edits. Revisions saved from a dynamic run come back as the
 * function bodies the agent wrote (`body`); anything else (imported or hand-written modules) comes back whole
 * (`module`). Re-saving either form reproduces the same source.
 */
export const editableRevisionSources = (input: {
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly clientCssPath?: string
}): { readonly format: 'body' | 'module'; readonly host?: string; readonly client?: string } => {
  const host = input.sources.host === undefined ? undefined : unwrap(input.sources.host, HOST_HEADER)
  const clientPrefix = input.clientCssPath === undefined ? '' : `${cssImport(input.clientCssPath)}\n`
  const client =
    input.sources.client === undefined ? undefined : unwrap(input.sources.client, `${clientPrefix}${CLIENT_HEADER}`)
  const bodies =
    (input.sources.host === undefined || host !== undefined) &&
    (input.sources.client === undefined || client !== undefined)
  if (bodies && wrapsBack(host, client, input)) {
    return { format: 'body', ...(host === undefined ? {} : { host }), ...(client === undefined ? {} : { client }) }
  }
  return { format: 'module', ...input.sources }
}

const wrapsBack = (
  host: string | undefined,
  client: string | undefined,
  input: { readonly sources: { readonly host?: string; readonly client?: string }; readonly clientCssPath?: string },
): boolean =>
  (host === undefined || wrapHost(host) === input.sources.host) &&
  (client === undefined || wrapClient(client, input.clientCssPath) === input.sources.client)

/** Client CSS is scoped to this Revision's rendered UI, so it is only meaningful with a Client half. */
export const assertClientCssScope = (input: { readonly hasClientCss: boolean; readonly hasClient: boolean }): void => {
  if (input.hasClientCss && !input.hasClient) throw new Error('Client CSS 需要同时提交 Client 源码。')
}

export function materializeDynamicPackage(input: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly snapshot: DynamicPackageSnapshot
  /** Written into the Manifest; a lineage requires the governance SDK level. */
  readonly lineage?: ExtensionLineage
  /** Configuration of the version a revise starts from: fields it leaves to administrators stay that way. */
  readonly baseConfig?: ExtensionManifest['config'] | undefined
}): MaterializedExtensionRevision {
  const parsed = inputSchema.parse({
    snapshot: input.snapshot,
  })
  const contributions = parsed.snapshot.contributions
  assertClientCssScope({
    hasClientCss: parsed.snapshot.clientCss !== undefined,
    hasClient: parsed.snapshot.clientCode !== undefined,
  })
  const modules = parsed.snapshot.codeFormat === 'module'
  const sources = revisionSourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined
      ? {}
      : { host: modules ? normalizeSource(parsed.snapshot.hostCode) : wrapHost(parsed.snapshot.hostCode) }),
    ...(parsed.snapshot.clientCode === undefined
      ? {}
      : {
          client: modules
            ? normalizeSource(parsed.snapshot.clientCode)
            : wrapClient(parsed.snapshot.clientCode, parsed.snapshot.clientCss?.path),
        }),
  })
  const permissions = parsed.snapshot.permissions ?? { permissions: [], networkOrigins: [] }
  // The generated Host factory now consumes the SDK 9 environment (including logger). Do not guess capability
  // use from source text: callbacks may only log long after verification. Imported old manifests stay unchanged.
  const required = Math.max(
    requiredExtensionSdkLevel(permissions).level,
    parsed.snapshot.hostCode === undefined ? EXTENSION_SDK_BASE_LEVEL : EXTENSION_SDK_LEVEL,
    input.lineage !== undefined || parsed.snapshot.dataVersion !== undefined ? EXTENSION_GOVERNANCE_SDK_LEVEL : 0,
  )
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
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    ...(parsed.snapshot.dataVersion === undefined ? {} : { dataVersion: parsed.snapshot.dataVersion }),
  })
  assertAgentAuthoredConfig(manifest.config, input.baseConfig)

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

/**
 * The same code and resources under a new extension and Revision identity with the given lineage, as a branch needs.
 * Everything that decides behaviour stays byte-for-byte; only identity, lineage and the SDK level they need change.
 */
export function rematerializeRevision(input: {
  readonly content: {
    readonly manifest: ExtensionManifest
    readonly sources: { readonly host?: string; readonly client?: string }
    readonly resources: Readonly<Record<string, string>>
  }
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly lineage: ExtensionLineage
}): MaterializedExtensionRevision {
  const sdk = Math.max(input.content.manifest.requires?.sdk ?? 0, EXTENSION_GOVERNANCE_SDK_LEVEL)
  const manifest = extensionManifestSchema.parse({
    ...input.content.manifest,
    extensionId: input.extensionId,
    revisionId: input.revisionId,
    requires: { sdk },
    lineage: input.lineage,
  })
  const sources = revisionSourcesSchema.parse(input.content.sources)
  const resources = revisionResourcesSchema.parse(input.content.resources)
  validateRevisionResources(manifest, resources, '扩展分支')
  return {
    manifest,
    sources,
    resources,
    ...revisionDigests({ manifest, sources, resources }),
    provides: extensionProvides(manifest),
  }
}
