import {
  AdapterClientSlotNameSchema,
  AgentClientSlotNameSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  type ExtensionId,
  type ExtensionRevisionId,
  type HostPageContribution,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DynamicPackageSnapshot, MaterializedExtensionRevision } from './types.js'
import { validateHostUiCss, validateHostUiSvg } from './ui-assets.js'

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
        permissions: HostUiPermissionDeclarationSchema.optional(),
        contributions: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('tool'), name: z.string(), description: z.string() }).strict(),
              z.object({ kind: z.literal('rpc'), method: z.string() }).strict(),
              z
                .object({
                  kind: z.literal('client-slot'),
                  name: AgentClientSlotNameSchema,
                })
                .strict(),
              z
                .object({
                  kind: z.literal('adapter'),
                  apiVersion: z.literal(1),
                  key: z.string().trim().min(1),
                  descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('host-client-slot'),
                  name: AdapterClientSlotNameSchema,
                  key: z.string().trim().min(1),
                })
                .strict(),
              HostPageContributionSchema,
            ]),
          )
          .default([]),
      })
      .strict()
      .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
        message: 'A dynamic Package snapshot needs a Host or Client source half.',
      }),
  })
  .strict()

const normalizeSource = (source: string): string => source.replaceAll('\r\n', '\n').trim() + '\n'

const sourcesSchema = z.union([
  z.object({ host: z.string(), client: z.string() }).strict(),
  z.object({ host: z.string() }).strict(),
  z.object({ client: z.string() }).strict(),
])

const extensionEntrypointsSchema = z.union([
  z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
  z.object({ host: z.literal('source/host.ts') }).strict(),
  z.object({ client: z.literal('source/client.ts') }).strict(),
])

const clientCssSchema = z
  .object({
    path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

const resourcesSchema = z.record(z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u), z.string().max(256 * 1024))

const extensionManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
    contributions: inputSchema.shape.snapshot.shape.contributions,
  })
  .strict()

const hostAdapterManifestSchema = extensionManifestSchema
  .omit({ schemaVersion: true, entrypoints: true, contributions: true })
  .extend({
    schemaVersion: z.literal(3),
    scope: z.literal('host-adapter'),
    entrypoints: z.union([
      z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
      z.object({ host: z.literal('source/host.ts') }).strict(),
    ]),
    clientCss: clientCssSchema.optional(),
    contributions: inputSchema.shape.snapshot.shape.contributions,
  })
  .strict()

const hostUiManifestSchema = extensionManifestSchema
  .omit({ schemaVersion: true, entrypoints: true, contributions: true })
  .extend({
    schemaVersion: z.literal(4),
    scope: z.literal('host-ui'),
    entrypoints: z.union([
      z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
      z.object({ client: z.literal('source/client.ts') }).strict(),
    ]),
    clientCss: clientCssSchema.optional(),
    permissions: HostUiPermissionDeclarationSchema,
    contributions: z.array(HostPageContributionSchema).min(1).max(8),
  })
  .strict()

const digestInputSchema = z
  .object({
    manifest: z.union([extensionManifestSchema, hostAdapterManifestSchema, hostUiManifestSchema]),
    sources: sourcesSchema,
    resources: resourcesSchema,
  })
  .strict()

const payloadDigestInputSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        scope: z.enum(['host-adapter', 'host-ui']).optional(),
        entrypoints: extensionEntrypointsSchema,
        contributions: inputSchema.shape.snapshot.shape.contributions,
        permissions: HostUiPermissionDeclarationSchema.optional(),
        clientCss: clientCssSchema.optional(),
      })
      .strict(),
    sources: sourcesSchema,
    resources: resourcesSchema,
  })
  .strict()

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

const wrapHost = (body: string, hostUi: boolean): string =>
  normalizeSource(`import { ${hostUi ? 'defineHostUiExtension' : 'defineHostExtension'} } from '@nekro-nxt/extension-sdk'

export default ${hostUi ? 'defineHostUiExtension' : 'defineHostExtension'}(async ({ harness }) => {
${body}
})`)

const wrapClient = (body: string, hostUi: boolean): string =>
  normalizeSource(`import { ${hostUi ? 'defineHostUiClientExtension' : 'defineClientExtension'} } from '@nekro-nxt/extension-sdk'

export default ${hostUi ? 'defineHostUiClientExtension' : 'defineClientExtension'}(async ({ React, host, ${hostUi ? 'ui' : 'styles'} }) => {
${body}
})`)

export function materializeDynamicPackage(input: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly snapshot: DynamicPackageSnapshot
}): MaterializedExtensionRevision {
  const parsed = inputSchema.parse({
    snapshot: input.snapshot,
  })
  const adapters = parsed.snapshot.contributions.filter(({ kind }) => kind === 'adapter')
  const hostSlots = parsed.snapshot.contributions.filter(({ kind }) => kind === 'host-client-slot')
  const hostPages = parsed.snapshot.contributions.filter(
    (contribution): contribution is HostPageContribution => contribution.kind === 'host-page',
  )
  const agentContributions = parsed.snapshot.contributions.filter(
    ({ kind }) => kind !== 'adapter' && kind !== 'host-client-slot' && kind !== 'host-page',
  )
  const isHostAdapter = adapters.length > 0 || hostSlots.length > 0
  const isHostUi = !isHostAdapter && hostPages.length > 0
  if (isHostAdapter && (adapters.length !== 1 || agentContributions.length > 0 || !parsed.snapshot.hostCode)) {
    throw new Error('适配器 Revision 必须包含一个 Host Adapter，且不能混装智能体工具、RPC 或 Slot。')
  }
  if (isHostAdapter && hostPages.length > 8) throw new Error('一个适配器 Revision 最多贡献 8 个顶级页面。')
  if (hostPages.some(({ icon }) => icon.kind === 'svg')) {
    throw new Error('动态页面当前只能使用 Host 图标；SVG 文件请通过扩展导入包提供。')
  }
  if (isHostUi && (agentContributions.length > 0 || !parsed.snapshot.clientCode)) {
    throw new Error('Host UI Revision 必须包含 Client，且不能混装智能体工具、RPC 或 Slot。')
  }
  const sources = sourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined ? {} : { host: wrapHost(parsed.snapshot.hostCode, isHostUi) }),
    ...(parsed.snapshot.clientCode === undefined ? {} : { client: wrapClient(parsed.snapshot.clientCode, isHostUi) }),
  })
  const manifest = isHostAdapter
    ? hostAdapterManifestSchema.parse({
        schemaVersion: 3,
        scope: 'host-adapter',
        extensionId: input.extensionId,
        revisionId: input.revisionId,
        entrypoints: {
          host: 'source/host.ts',
          ...('client' in sources ? { client: 'source/client.ts' } : {}),
        },
        contributions: parsed.snapshot.contributions,
      })
    : isHostUi
      ? hostUiManifestSchema.parse({
          schemaVersion: 4,
          scope: 'host-ui',
          extensionId: input.extensionId,
          revisionId: input.revisionId,
          entrypoints: {
            ...('host' in sources ? { host: 'source/host.ts' } : {}),
            client: 'source/client.ts',
          },
          permissions: parsed.snapshot.permissions ?? { permissions: [], networkOrigins: [] },
          contributions: hostPages,
        })
      : extensionManifestSchema.parse({
          schemaVersion: 2,
          extensionId: input.extensionId,
          revisionId: input.revisionId,
          entrypoints: {
            ...('host' in sources ? { host: 'source/host.ts' } : {}),
            ...('client' in sources ? { client: 'source/client.ts' } : {}),
          },
          contributions: parsed.snapshot.contributions,
        })
  const resources = resourcesSchema.parse({})
  const digestInput = canonicalJson(JsonValueSchema.parse(digestInputSchema.parse({ manifest, sources, resources })))
  const payloadManifest = {
    schemaVersion: manifest.schemaVersion,
    ...('scope' in manifest ? { scope: manifest.scope } : {}),
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
    ...('permissions' in manifest ? { permissions: manifest.permissions } : {}),
    ...('clientCss' in manifest && manifest.clientCss ? { clientCss: manifest.clientCss } : {}),
  }
  const payloadDigestInput = canonicalJson(
    JsonValueSchema.parse(payloadDigestInputSchema.parse({ manifest: payloadManifest, sources, resources })),
  )
  return {
    manifest,
    sources,
    resources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
    payloadDigest: createHash('sha256').update(payloadDigestInput).digest('hex'),
    scope: isHostAdapter ? 'host-adapter' : isHostUi ? 'host-ui' : 'agent',
  }
}

/** Recomputes canonical digests for a transferred immutable Revision without trusting archive metadata. */
export function materializeImportedRevision(input: {
  readonly manifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
}): MaterializedExtensionRevision {
  const manifest = z
    .union([extensionManifestSchema, hostAdapterManifestSchema, hostUiManifestSchema])
    .parse(input.manifest)
  const sources = sourcesSchema.parse({
    ...(input.sources.host === undefined ? {} : { host: normalizeSource(input.sources.host) }),
    ...(input.sources.client === undefined ? {} : { client: normalizeSource(input.sources.client) }),
  })
  const resources = resourcesSchema.parse(input.resources ?? {})
  if (
    'host' in manifest.entrypoints !== 'host' in sources ||
    'client' in manifest.entrypoints !== 'client' in sources
  ) {
    throw new Error('导入扩展的 Manifest entrypoints 与源码文件不一致。')
  }
  const expectedResources = new Map<string, string>()
  if ('clientCss' in manifest && manifest.clientCss)
    expectedResources.set(manifest.clientCss.path, manifest.clientCss.sha256)
  for (const page of 'contributions' in manifest ? manifest.contributions : []) {
    if (page.kind === 'host-page' && page.icon.kind === 'svg') expectedResources.set(page.icon.path, page.icon.sha256)
  }
  if (expectedResources.size !== Object.keys(resources).length) {
    throw new Error('导入扩展的资源文件与 Manifest 声明不一致。')
  }
  for (const [resourcePath, expectedDigest] of expectedResources) {
    const source = resources[resourcePath]
    if (source === undefined) throw new Error(`导入扩展缺少资源：${resourcePath}`)
    const digest = createHash('sha256').update(source).digest('hex')
    if (digest !== expectedDigest) throw new Error(`导入扩展资源摘要不一致：${resourcePath}`)
    if (resourcePath.endsWith('.module.css')) validateHostUiCss(source)
    else if (resourcePath.endsWith('.svg')) validateHostUiSvg(source)
    else throw new Error(`导入扩展包含不支持的资源：${resourcePath}`)
  }
  const digestInput = canonicalJson(JsonValueSchema.parse(digestInputSchema.parse({ manifest, sources, resources })))
  const payloadManifest = {
    schemaVersion: manifest.schemaVersion,
    ...('scope' in manifest ? { scope: manifest.scope } : {}),
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
    ...('permissions' in manifest ? { permissions: manifest.permissions } : {}),
    ...('clientCss' in manifest && manifest.clientCss ? { clientCss: manifest.clientCss } : {}),
  }
  const payloadDigestInput = canonicalJson(
    JsonValueSchema.parse(payloadDigestInputSchema.parse({ manifest: payloadManifest, sources, resources })),
  )
  return {
    manifest,
    sources,
    resources,
    contentDigest: createHash('sha256').update(digestInput).digest('hex'),
    payloadDigest: createHash('sha256').update(payloadDigestInput).digest('hex'),
    scope: manifest.schemaVersion === 3 ? 'host-adapter' : manifest.schemaVersion === 4 ? 'host-ui' : 'agent',
  }
}
