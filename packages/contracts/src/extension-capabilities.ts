import { z } from 'zod'

/**
 * Host capability level this build implements. A Revision that declares `requires.sdk` above it is rejected at
 * import with an "upgrade NekroNXT" message instead of an opaque schema error. Bump only when a new optional
 * Manifest capability ships; never reuse a level for a different meaning.
 */
export const EXTENSION_SDK_LEVEL = 2

export const ExtensionRequiresSchema = z.object({ sdk: z.number().int().min(1).max(1000) }).strict()
export type ExtensionRequires = z.output<typeof ExtensionRequiresSchema>

/** `api.example.com` or `*.example.com` (subdomains only); lower-case DNS labels, no scheme, port or path. */
export const ExtensionNetworkDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u, {
    message: '网络域名必须是 api.example.com 或 *.example.com 形式，不含协议、端口和路径。',
  })

export const ExtensionNetworkCapabilitySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('domains'),
      domains: z.array(ExtensionNetworkDomainSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      mode: z.literal('config'),
      /** Top-level config fields whose current value is a URL or host the user typed. */
      fields: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      mode: z.literal('unrestricted'),
      /** Shown to the user next to the risk acknowledgement. */
      purpose: z.string().trim().min(4).max(200),
    })
    .strict(),
])
export type ExtensionNetworkCapability = z.output<typeof ExtensionNetworkCapabilitySchema>

export const EXTENSION_STORAGE_SCOPES = ['agent', 'channel', 'member', 'shared'] as const
export const ExtensionStorageScopeSchema = z.enum(EXTENSION_STORAGE_SCOPES)
export type ExtensionStorageScope = z.output<typeof ExtensionStorageScopeSchema>

export const EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024
export const EXTENSION_STORAGE_MAX_QUOTA_BYTES = 64 * 1024 * 1024

export const ExtensionStorageCapabilitySchema = z
  .object({
    scopes: z.array(ExtensionStorageScopeSchema).min(1).max(EXTENSION_STORAGE_SCOPES.length),
    quotaBytes: z.number().int().min(1024).max(EXTENSION_STORAGE_MAX_QUOTA_BYTES).optional(),
  })
  .strict()
  .refine((value) => new Set(value.scopes).size === value.scopes.length, '存储作用域不能重复。')
export type ExtensionStorageCapability = z.output<typeof ExtensionStorageCapabilitySchema>

export const EXTENSION_CONTEXT_STATIC_MAX_CHARS = 4000
export const EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS = 2000

export const ExtensionContextContributionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, '上下文名称只能使用小写字母、数字和连字符。'),
    kind: z.enum(['static', 'dynamic']),
    maxChars: z.number().int().min(1).max(EXTENSION_CONTEXT_STATIC_MAX_CHARS),
  })
  .strict()
  .refine(
    (value) => value.kind === 'static' || value.maxChars <= EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
    `动态上下文最多 ${EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS} 字。`,
  )
export type ExtensionContextContribution = z.output<typeof ExtensionContextContributionSchema>

/**
 * Optional Host capabilities of an agent-scope Revision. Every field is additive to Manifest V6: an absent field
 * means the Revision cannot use that capability, exactly as before the field existed.
 */
export const ExtensionCapabilitiesSchema = z
  .object({
    network: ExtensionNetworkCapabilitySchema.optional(),
    storage: ExtensionStorageCapabilitySchema.optional(),
    assets: z
      .object({ write: z.literal(true) })
      .strict()
      .optional(),
    history: z
      .object({ read: z.literal(true) })
      .strict()
      .optional(),
    context: z
      .array(ExtensionContextContributionSchema)
      .max(8)
      .refine((value) => new Set(value.map(({ name }) => name)).size === value.length, '上下文名称不能重复。')
      .optional(),
  })
  .strict()
export type ExtensionCapabilities = z.output<typeof ExtensionCapabilitiesSchema>

const NETWORK_MODE_RANK = { domains: 0, config: 1, unrestricted: 2 } as const

const networkExpands = (
  previous: ExtensionNetworkCapability | undefined,
  next: ExtensionNetworkCapability | undefined,
): boolean => {
  if (next === undefined) return false
  if (previous === undefined) return true
  if (NETWORK_MODE_RANK[next.mode] !== NETWORK_MODE_RANK[previous.mode]) {
    return NETWORK_MODE_RANK[next.mode] > NETWORK_MODE_RANK[previous.mode]
  }
  if (next.mode === 'domains' && previous.mode === 'domains') {
    return next.domains.some((domain) => !previous.domains.includes(domain))
  }
  if (next.mode === 'config' && previous.mode === 'config') {
    return next.fields.some((field) => !previous.fields.includes(field))
  }
  return false
}

/**
 * Whether `next` asks for something an approval of `previous` did not cover. Narrowing never needs approval;
 * storage quota is bounded by the Host maximum and is not an expansion. Context contributions are capped text
 * shown in the trace, so adding one is not an expansion either.
 */
export const extensionCapabilitiesExpand = (
  previous: ExtensionCapabilities | undefined,
  next: ExtensionCapabilities | undefined,
): boolean => {
  if (next === undefined) return false
  if (networkExpands(previous?.network, next.network)) return true
  if (next.storage?.scopes.some((scope) => !(previous?.storage?.scopes ?? []).includes(scope))) return true
  if (next.assets !== undefined && previous?.assets === undefined) return true
  if (next.history !== undefined && previous?.history === undefined) return true
  return false
}

/** Capability risk tiers shown on the approval page (§7 of the capability decision). */
export type ExtensionCapabilityRisk = 'normal' | 'sensitive' | 'high'

export interface ExtensionCapabilitySummaryItem {
  readonly key: string
  readonly risk: ExtensionCapabilityRisk
  readonly label: string
  readonly detail?: string
}

/** User-facing summary of declared capabilities, in a stable order, for approval and inspection pages. */
export const summarizeExtensionCapabilities = (
  capabilities: ExtensionCapabilities | undefined,
): readonly ExtensionCapabilitySummaryItem[] => {
  if (capabilities === undefined) return []
  const items: ExtensionCapabilitySummaryItem[] = []
  const network = capabilities.network
  if (network?.mode === 'domains') {
    items.push({ key: 'network', risk: 'normal', label: '访问指定网站', detail: network.domains.join('、') })
  } else if (network?.mode === 'config') {
    items.push({ key: 'network', risk: 'normal', label: '访问你在配置中填写的地址', detail: network.fields.join('、') })
  } else if (network?.mode === 'unrestricted') {
    items.push({ key: 'network', risk: 'high', label: '访问任意公网地址', detail: network.purpose })
  }
  if (capabilities.storage !== undefined) {
    const shared = capabilities.storage.scopes.includes('shared')
    items.push({
      key: 'storage',
      risk: shared ? 'sensitive' : 'normal',
      label: shared ? '保存数据，并在启用它的智能体之间共享' : '为这个智能体保存数据',
    })
  }
  if (capabilities.assets !== undefined)
    items.push({ key: 'assets', risk: 'normal', label: '在当前频道生成图片或文件' })
  if (capabilities.history !== undefined)
    items.push({ key: 'history', risk: 'normal', label: '读取当前频道的聊天记录' })
  if (capabilities.context !== undefined && capabilities.context.length > 0) {
    items.push({
      key: 'context',
      risk: 'normal',
      label: '向智能体提供补充说明',
      detail: capabilities.context.map(({ name }) => name).join('、'),
    })
  }
  return items
}
