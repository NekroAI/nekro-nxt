import {
  adapterContributionSchema,
  clientCssSchema,
  extensionEntrypointsSchema,
  extensionManifestSchema,
  rpcContributionSchema,
  toolContributionSchema,
} from './manifest.js'
import {
  ExtensionConfigDeclarationSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  MessageRendererContributionSchema,
  PanelContributionSchema,
  ToolViewContributionSchema,
  JsonValueSchema,
  type ExtensionId,
  type ExtensionRevisionId,
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
        config: ExtensionConfigDeclarationSchema.optional(),
        contributions: z
          .array(
            z.union([
              toolContributionSchema,
              rpcContributionSchema,
              PanelContributionSchema,
              ToolViewContributionSchema,
              MessageRendererContributionSchema,
              adapterContributionSchema,
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

const resourcesSchema = z.record(z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u), z.string().max(256 * 1024))

const digestInputSchema = z
  .object({
    manifest: extensionManifestSchema,
    sources: sourcesSchema,
    resources: resourcesSchema,
  })
  .strict()

const payloadDigestInputSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.literal(6),
        scope: z.enum(['agent', 'host-adapter', 'host-ui']),
        entrypoints: extensionEntrypointsSchema,
        contributions: inputSchema.shape.snapshot.shape.contributions,
        permissions: HostUiPermissionDeclarationSchema,
        config: ExtensionConfigDeclarationSchema.optional(),
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

const wrapHost = (body: string): string =>
  normalizeSource(`import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => {
${body}
})`)

const wrapClient = (body: string, clientCssPath?: string): string =>
  normalizeSource(`${clientCssPath === undefined ? '' : `import '../${clientCssPath}?nxt-dynamic-css'\n`}
import { defineClientExtension } from '@nekro-nxt/extension-sdk'

export default defineClientExtension(async ({ React, host, styles }) => {
${body}
})`)

const AGENT_KINDS = new Set(['tool', 'rpc', 'panel', 'tool-view'])

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
  const isHostAdapter = contributions.some(({ kind }) => kind === 'adapter' || kind === 'message-renderer')
  const hasAgentContribution = contributions.some(({ kind }) => AGENT_KINDS.has(kind))
  const isHostUi = !isHostAdapter && !hasAgentContribution && contributions.some(({ kind }) => kind === 'host-page')
  if (isHostAdapter && !parsed.snapshot.hostCode) throw new Error('适配器 Revision 必须包含 Host Adapter。')
  if (isHostAdapter && contributions.some(({ kind }) => kind === 'tool' || kind === 'rpc' || kind === 'tool-view')) {
    throw new Error('适配器 Revision 不能混装智能体工具、RPC 或工具视图，请拆分为两个扩展。')
  }
  if (!isHostAdapter && hasAgentContribution && contributions.some(({ kind }) => kind === 'host-page')) {
    throw new Error('智能体扩展不能贡献顶级页面，请拆分为两个扩展。')
  }
  if (isHostUi && !parsed.snapshot.clientCode) throw new Error('页面 Revision 必须包含 Client。')
  assertClientCssScope({
    hasClientCss: parsed.snapshot.clientCss !== undefined,
    hasClient: parsed.snapshot.clientCode !== undefined,
  })
  const sources = sourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined ? {} : { host: wrapHost(parsed.snapshot.hostCode) }),
    ...(parsed.snapshot.clientCode === undefined
      ? {}
      : { client: wrapClient(parsed.snapshot.clientCode, parsed.snapshot.clientCss?.path) }),
  })
  const scope = isHostAdapter ? 'host-adapter' : isHostUi ? 'host-ui' : 'agent'
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 6,
    scope,
    extensionId: input.extensionId,
    revisionId: input.revisionId,
    entrypoints: {
      ...('host' in sources ? { host: 'source/host.ts' } : {}),
      ...('client' in sources ? { client: 'source/client.ts' } : {}),
    },
    ...(parsed.snapshot.clientCss === undefined ? {} : { clientCss: parsed.snapshot.clientCss }),
    permissions: parsed.snapshot.permissions ?? { permissions: [], networkOrigins: [] },
    ...(parsed.snapshot.config === undefined ? {} : { config: parsed.snapshot.config }),
    contributions,
  })
  const resources = resourcesSchema.parse(parsed.snapshot.resources ?? {})
  const expectedResources = new Map<string, { readonly digest: string; readonly kind: 'css' | 'svg' }>()
  if (parsed.snapshot.clientCss) {
    expectedResources.set(parsed.snapshot.clientCss.path, { digest: parsed.snapshot.clientCss.sha256, kind: 'css' })
  }
  for (const contribution of parsed.snapshot.contributions) {
    if (contribution.kind === 'host-page' && contribution.icon.kind === 'svg') {
      expectedResources.set(contribution.icon.path, { digest: contribution.icon.sha256, kind: 'svg' })
    }
  }
  if (expectedResources.size !== Object.keys(resources).length) {
    throw new Error('动态扩展资源文件与 Manifest 声明不一致。')
  }
  for (const [resourcePath, expected] of expectedResources) {
    const source = resources[resourcePath]
    if (source === undefined) throw new Error(`动态扩展缺少资源：${resourcePath}`)
    if (createHash('sha256').update(source).digest('hex') !== expected.digest) {
      throw new Error(`动态扩展资源摘要不一致：${resourcePath}`)
    }
    if (expected.kind === 'css') validateHostUiCss(source)
    else validateHostUiSvg(source)
  }
  const digestInput = canonicalJson(JsonValueSchema.parse(digestInputSchema.parse({ manifest, sources, resources })))
  const payloadManifest = {
    schemaVersion: manifest.schemaVersion,
    scope: manifest.scope,
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
    permissions: manifest.permissions,
    ...(manifest.config === undefined ? {} : { config: manifest.config }),
    ...(manifest.clientCss ? { clientCss: manifest.clientCss } : {}),
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
    scope,
  }
}

/** Recomputes canonical digests for a transferred immutable Revision without trusting archive metadata. */
export function materializeImportedRevision(input: {
  readonly manifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
}): MaterializedExtensionRevision {
  const manifest = extensionManifestSchema.parse(input.manifest)
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
  if (manifest.clientCss) expectedResources.set(manifest.clientCss.path, manifest.clientCss.sha256)
  for (const page of manifest.contributions) {
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
    scope: manifest.scope,
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
    permissions: manifest.permissions,
    ...(manifest.config === undefined ? {} : { config: manifest.config }),
    ...(manifest.clientCss ? { clientCss: manifest.clientCss } : {}),
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
    scope: manifest.scope,
  }
}
