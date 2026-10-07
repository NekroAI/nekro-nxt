import {
  ExtensionConfigDeclarationSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  MessageRendererContributionSchema,
  PanelContributionSchema,
  ToolViewContributionSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { z } from 'zod'
import {
  adapterContributionSchema,
  clientCssSchema,
  extensionEntrypointsSchema,
  extensionManifestSchema,
  rpcContributionSchema,
  toolContributionSchema,
  type ExtensionManifest,
} from './manifest.js'
import { validateHostUiCss, validateHostUiSvg } from './ui-assets.js'

/** 十六进制 SHA-256；同步实现，Node、浏览器与 Cloudflare Workers 结果一致。 */
export const sha256Hex = (input: string | Uint8Array): string =>
  bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input))

/** 源码统一为 LF 结尾并保留末尾换行，摘要与平台换行无关。 */
export const normalizeSource = (source: string): string => source.replaceAll('\r\n', '\n').trim() + '\n'

export const revisionSourcesSchema = z.union([
  z.object({ host: z.string(), client: z.string() }).strict(),
  z.object({ host: z.string() }).strict(),
  z.object({ client: z.string() }).strict(),
])

export const revisionResourcesSchema = z.record(
  z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u),
  z.string().max(256 * 1024),
)

export const extensionContributionSchema = z.union([
  toolContributionSchema,
  rpcContributionSchema,
  PanelContributionSchema,
  ToolViewContributionSchema,
  MessageRendererContributionSchema,
  adapterContributionSchema,
  HostPageContributionSchema,
])

const digestInputSchema = z
  .object({
    manifest: extensionManifestSchema,
    sources: revisionSourcesSchema,
    resources: revisionResourcesSchema,
  })
  .strict()

const payloadDigestInputSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.literal(6),
        scope: z.enum(['agent', 'host-adapter', 'host-ui']),
        entrypoints: extensionEntrypointsSchema,
        contributions: z.array(extensionContributionSchema),
        permissions: HostUiPermissionDeclarationSchema,
        config: ExtensionConfigDeclarationSchema.optional(),
        clientCss: clientCssSchema.optional(),
      })
      .strict(),
    sources: revisionSourcesSchema,
    resources: revisionResourcesSchema,
  })
  .strict()

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

export interface RevisionContent {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources: Readonly<Record<string, string>>
}

/**
 * Revision 的两种摘要。`contentDigest` 覆盖完整清单（含身份），用于识别同一次保存；`payloadDigest` 只覆盖
 * 决定运行行为的部分，跨身份比较「内容是否相同」。
 */
export const revisionDigests = (
  content: RevisionContent,
): { readonly contentDigest: string; readonly payloadDigest: string } => {
  const { manifest, sources, resources } = content
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
  return { contentDigest: sha256Hex(digestInput), payloadDigest: sha256Hex(payloadDigestInput) }
}

export interface MaterializedExtensionRevision {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
  readonly contentDigest: string
  readonly payloadDigest: string
  readonly scope: 'agent' | 'host-adapter' | 'host-ui'
}

/** 校验导入的清单、源码与资源并计算摘要；与 NekroNXT 保存时的计算完全相同。 */
export function materializeImportedRevision(input: {
  readonly manifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
}): MaterializedExtensionRevision {
  const manifest = extensionManifestSchema.parse(input.manifest)
  const sources = revisionSourcesSchema.parse({
    ...(input.sources.host === undefined ? {} : { host: normalizeSource(input.sources.host) }),
    ...(input.sources.client === undefined ? {} : { client: normalizeSource(input.sources.client) }),
  })
  const resources = revisionResourcesSchema.parse(input.resources ?? {})
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
    if (sha256Hex(source) !== expectedDigest) throw new Error(`导入扩展资源摘要不一致：${resourcePath}`)
    if (resourcePath.endsWith('.module.css')) validateHostUiCss(source)
    else if (resourcePath.endsWith('.svg')) validateHostUiSvg(source)
    else throw new Error(`导入扩展包含不支持的资源：${resourcePath}`)
  }
  return { manifest, sources, resources, ...revisionDigests({ manifest, sources, resources }), scope: manifest.scope }
}
