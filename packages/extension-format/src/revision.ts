import {
  EXTENSION_SDK_LEVEL,
  ExtensionLayeredConfigSchema,
  ExtensionPermissionsSchema,
  HostPageContributionSchema,
  JsonValueSchema,
  type ExtensionProvide,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { z } from 'zod'
import {
  clientCssSchema,
  extensionEntrypointsSchema,
  extensionManifestContributionSchema,
  extensionManifestSchema,
  extensionProvides,
  type ExtensionManifest,
} from './manifest.js'
import { extensionIconSchema, resourceDigest, validateExtensionIcon } from './icon.js'
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

export const extensionContributionSchema = extensionManifestContributionSchema

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
        schemaVersion: z.literal(7),
        entrypoints: extensionEntrypointsSchema,
        contributions: z.array(extensionContributionSchema),
        permissions: ExtensionPermissionsSchema,
        config: ExtensionLayeredConfigSchema.optional(),
        clientCss: clientCssSchema.optional(),
        icon: extensionIconSchema.optional(),
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
    entrypoints: manifest.entrypoints,
    contributions: manifest.contributions,
    permissions: manifest.permissions,
    ...(manifest.config === undefined ? {} : { config: manifest.config }),
    ...(manifest.clientCss ? { clientCss: manifest.clientCss } : {}),
    ...(manifest.icon ? { icon: manifest.icon } : {}),
  }
  const payloadDigestInput = canonicalJson(
    JsonValueSchema.parse(payloadDigestInputSchema.parse({ manifest: payloadManifest, sources, resources })),
  )
  return { contentDigest: sha256Hex(digestInput), payloadDigest: sha256Hex(payloadDigestInput) }
}

export type RevisionResourceKind = 'css' | 'svg' | 'icon'

/** Manifest 声明的全部资源：Client CSS、页面 SVG 图标与扩展图标，键是资源路径。 */
export const expectedRevisionResources = (manifest: {
  readonly clientCss?: { readonly path: string; readonly sha256: string } | undefined
  readonly icon?: { readonly path: string; readonly sha256: string } | undefined
  readonly contributions: readonly unknown[]
}): Map<string, { readonly digest: string; readonly kind: RevisionResourceKind }> => {
  const expected = new Map<string, { readonly digest: string; readonly kind: RevisionResourceKind }>()
  if (manifest.clientCss) expected.set(manifest.clientCss.path, { digest: manifest.clientCss.sha256, kind: 'css' })
  for (const contribution of manifest.contributions) {
    const page = HostPageContributionSchema.safeParse(contribution)
    if (page.success && page.data.icon.kind === 'svg') {
      expected.set(page.data.icon.path, { digest: page.data.icon.sha256, kind: 'svg' })
    }
  }
  if (manifest.icon) {
    const shared = expected.get(manifest.icon.path)
    if (shared !== undefined && shared.digest !== manifest.icon.sha256) {
      throw new Error(`扩展图标与其他资源共用路径但摘要不同：${manifest.icon.path}`)
    }
    expected.set(manifest.icon.path, { digest: manifest.icon.sha256, kind: 'icon' })
  }
  return expected
}

/** 校验资源恰好是 Manifest 声明的那些、摘要一致且内容合规；`label` 只决定错误文案的主语。 */
export const validateRevisionResources = (
  manifest: Parameters<typeof expectedRevisionResources>[0],
  resources: Readonly<Record<string, string>>,
  label: '导入扩展' | '动态扩展',
): void => {
  const expected = expectedRevisionResources(manifest)
  const subject = label === '导入扩展' ? '导入扩展的' : '动态扩展'
  if (expected.size !== Object.keys(resources).length) throw new Error(`${subject}资源文件与 Manifest 声明不一致。`)
  for (const [resourcePath, { digest, kind }] of expected) {
    const source = resources[resourcePath]
    if (source === undefined) throw new Error(`${label}缺少资源：${resourcePath}`)
    let actual: string
    try {
      actual = resourceDigest(resourcePath, source)
    } catch {
      throw new Error(`${label}资源编码无效：${resourcePath}`)
    }
    if (actual !== digest) throw new Error(`${label}资源摘要不一致：${resourcePath}`)
    if (kind === 'icon') validateExtensionIcon(resourcePath, source)
    else if (kind === 'css' && resourcePath.endsWith('.module.css')) validateHostUiCss(source)
    else if (kind === 'svg' && resourcePath.endsWith('.svg')) validateHostUiSvg(source)
    else throw new Error(`${label}包含不支持的资源：${resourcePath}`)
  }
}

export interface MaterializedExtensionRevision {
  readonly manifest: ExtensionManifest
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
  readonly contentDigest: string
  readonly payloadDigest: string
  readonly provides: readonly ExtensionProvide[]
}

/** 旧格式（Manifest V6 / 传输包 v1）扩展的统一提示；扩展形态统一后不再读取旧格式。 */
export const LEGACY_EXTENSION_MESSAGE =
  '这是旧格式的扩展，当前 NekroNXT 已不再支持。请从社区获取新版，或让智能体重新创造。'

/** Rejects a Manifest written in a retired format with a message the user can act on. */
export const assertCurrentManifestFormat = (manifest: unknown): void => {
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'schemaVersion' in manifest &&
    typeof manifest.schemaVersion === 'number' &&
    manifest.schemaVersion < 7
  ) {
    throw new Error(LEGACY_EXTENSION_MESSAGE)
  }
  // Checked before the schema: a newer extension declares capabilities this version cannot parse, and the user should
  // learn to upgrade rather than read validation errors about them.
  const sdk = requiredSdk(manifest)
  if (sdk !== undefined && sdk > EXTENSION_SDK_LEVEL) {
    throw new Error(
      `这个扩展需要更新版本的 NekroNXT（扩展能力等级 ${sdk}，当前为 ${EXTENSION_SDK_LEVEL}）。请先升级 NekroNXT。`,
    )
  }
}

const requiredSdk = (manifest: unknown): number | undefined => {
  if (typeof manifest !== 'object' || manifest === null || !('requires' in manifest)) return undefined
  const requires: unknown = manifest.requires
  if (typeof requires !== 'object' || requires === null || !('sdk' in requires)) return undefined
  return typeof requires.sdk === 'number' ? requires.sdk : undefined
}

/** 校验导入的清单、源码与资源并计算摘要；与 NekroNXT 保存时的计算完全相同。 */
export function materializeImportedRevision(input: {
  readonly manifest: unknown
  readonly sources: { readonly host?: string; readonly client?: string }
  readonly resources?: Readonly<Record<string, string>>
}): MaterializedExtensionRevision {
  assertCurrentManifestFormat(input.manifest)
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
  validateRevisionResources(manifest, resources, '导入扩展')
  return {
    manifest,
    sources,
    resources,
    ...revisionDigests({ manifest, sources, resources }),
    provides: extensionProvides(manifest),
  }
}
