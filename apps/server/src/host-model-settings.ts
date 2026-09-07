import { HOST_DSH_PACKAGE_VERSIONS, DSH_BUILTIN_EXTENSION_ROSTER, DSH_SETTINGS_OWNER } from './dsh-roster.js'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmRuntime, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { settingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import {
  type DshCredentialView,
  type DshPluginCatalogEntry,
  type DshSettingsNamespaceView,
  type DshSettingsPathOperation,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
export interface AvailableLlmModel {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly string[]
}

const JsonObjectSchema = z.record(z.string(), z.unknown())

const SerializedSchemaNodeSchema = z
  .object({
    type: z.unknown().optional(),
    meta: z.object({ role: z.unknown().optional(), default: z.unknown().optional() }).passthrough().optional(),
    inner: z.unknown().optional(),
    dict: JsonObjectSchema.optional(),
    list: z.array(z.unknown()).optional(),
  })
  .passthrough()

const SerializedSchemaEnvelopeSchema = z
  .object({
    uid: z.number(),
    refs: JsonObjectSchema,
  })
  .passthrough()

export function isDshSettingsSchemaWireSafe(serialized: unknown): boolean {
  const envelopeResult = SerializedSchemaEnvelopeSchema.safeParse(serialized)
  if (!envelopeResult.success) return false
  const envelope = envelopeResult.data
  const nodeCache = new WeakMap<object, z.infer<typeof SerializedSchemaNodeSchema>>()
  const resolveNode = (reference: unknown): z.infer<typeof SerializedSchemaNodeSchema> | undefined => {
    const candidate = typeof reference === 'number' ? envelope.refs[String(reference)] : reference
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const cached = nodeCache.get(candidate)
    if (cached) return cached
    const result = SerializedSchemaNodeSchema.safeParse(candidate)
    if (!result.success) return undefined
    nodeCache.set(candidate, result.data)
    return result.data
  }
  const visited = new WeakMap<object, number>()
  let safe = true
  const visit = (reference: unknown, redactorCanReach: boolean): void => {
    const node = resolveNode(reference)
    if (!node || !safe) return
    const bit = redactorCanReach ? 1 : 2
    const previous = visited.get(node) ?? 0
    if ((previous & bit) !== 0) return
    visited.set(node, previous | bit)
    if (node.meta?.role === 'secret') {
      if (!redactorCanReach || Object.prototype.hasOwnProperty.call(node.meta, 'default')) safe = false
    }
    const type = typeof node.type === 'string' ? node.type : ''
    if (node.dict) {
      const supported = redactorCanReach && type === 'object'
      for (const child of Object.values(node.dict)) visit(child, supported)
    }
    if (node.inner !== undefined) {
      const supported = redactorCanReach && (type === 'dict' || type === 'array')
      visit(node.inner, supported)
    }
    for (const child of node.list ?? []) visit(child, false)
  }
  visit(envelope.uid, true)
  return safe
}

export interface ConfigurableLlmProviderView {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly settingsRevision: number
  readonly declared: boolean
  readonly active: boolean
  readonly configured: boolean
  readonly baseURL?: string
  readonly api?: string
  readonly credential?: { readonly configured: boolean; readonly source?: string; readonly writable: boolean }
  readonly models: readonly {
    readonly id: string
    readonly name: string
    readonly contextWindow?: number
    readonly maxTokens?: number
  }[]
}

export interface LlmProviderSettingsView {
  readonly writable: boolean
  readonly protocols: readonly string[]
  readonly providers: readonly ConfigurableLlmProviderView[]
}

export interface WebSearchCapabilityStatus {
  readonly provider: 'deepseek-official'
  readonly available: boolean
  readonly credentialConfigured: boolean
  readonly credentialReference: string
  readonly maxUsesPerCall: number
  readonly maxResultsPerCall: number
  readonly timeoutMs: number
}

export interface SaveLlmProviderInput {
  readonly provider: string
  readonly expectedRevision: number
  readonly apiKey?: string
  readonly displayName?: string
  readonly baseURL?: string
  readonly api?: string
  readonly models?: readonly {
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxTokens?: number
  }[]
}

export interface TestLlmProviderInput {
  readonly provider: string
  readonly model: string
  readonly settingsNs?: string
  readonly apiKey?: string
  readonly baseURL?: string
  readonly api?: string
  readonly models?: SaveLlmProviderInput['models']
}

const DRAFT_LLM_CREDENTIAL_REF = 'NEKRO_NXT_DRAFT_API_KEY'

class DraftLlmCredentialProvider extends CredentialProvider {
  readonly apiKey: string | undefined

  constructor(context: Context, config: { readonly apiKey?: string }) {
    super(context)
    this.apiKey = config.apiKey
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    await Promise.resolve()
    return ref === DRAFT_LLM_CREDENTIAL_REF && this.apiKey
      ? { value: this.apiKey, source: 'nekro-nxt-draft' }
      : undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    await Promise.resolve()
    return {
      configured: ref === DRAFT_LLM_CREDENTIAL_REF && Boolean(this.apiKey),
      source: 'nekro-nxt-draft',
      writable: false,
    }
  }

  set(): Promise<void> {
    return Promise.reject(new Error('连接测试的临时凭据只读。'))
  }

  unset(): Promise<void> {
    return Promise.reject(new Error('连接测试的临时凭据只读。'))
  }

  async readRecord(): Promise<CredentialRecord | undefined> {
    await Promise.resolve()
    return undefined
  }

  async describeRecord(): Promise<CredentialRecordInfo> {
    await Promise.resolve()
    return { configured: false, writable: false }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    await Promise.resolve()
    return []
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    void key
    void mutate
    return Promise.reject(new Error('连接测试的临时凭据不支持授权记录写入。'))
  }

  async deleteRecord(): Promise<void> {
    await Promise.resolve()
  }
}

const ConfiguredLlmModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
  })
  .passthrough()

const LlmProviderProfileSchema = z
  .object({
    apiKeyEnv: z.unknown().optional(),
    displayName: z.unknown().optional(),
    baseURL: z.unknown().optional(),
    api: z.unknown().optional(),
    models: z.unknown().optional(),
  })
  .passthrough()

const WebSearchSettingsSchema = z.object({ apiKeyEnv: z.unknown().optional() }).passthrough()

const readObjectPath = (value: unknown, pathSegments: readonly string[]): Record<string, unknown> | undefined => {
  let current: unknown = value
  for (const segment of pathSegments) {
    const result = JsonObjectSchema.safeParse(current)
    if (!result.success) return undefined
    current = result.data[segment]
  }
  const result = JsonObjectSchema.safeParse(current)
  return result.success ? result.data : undefined
}

const credentialReferenceForProvider = (provider: string): string =>
  `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
export class HostModelSettings {
  readonly #context: Context
  readonly #hasLlmSettings: boolean
  constructor(context: Context, hasSettings: boolean) {
    this.#context = context
    this.#hasLlmSettings = hasSettings
  }
  registerLlmAdapter(providers: string[], adapter: LlmAdapter): () => void {
    return this.#context.llm.registerAdapter(providers, adapter)
  }

  async listAvailableLlmModels(): Promise<readonly AvailableLlmModel[]> {
    const groups = await Promise.all(
      this.#context.llm.listProviders().map(async (provider) =>
        (await this.#context.llm.listModels(provider.id)).map((model) => ({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
        })),
      ),
    )
    return groups.flat()
  }

  async getLlmProviderSettings(): Promise<LlmProviderSettingsView> {
    if (!this.#hasLlmSettings) throw new Error('DSH 模型设置服务未启用。')
    const descriptors = new Map(
      this.#context.settings.describe({ redactSecrets: true }).map((descriptor) => [descriptor.ns, descriptor]),
    )
    const active = new Map(this.#context.llm.listProviders().map((provider) => [provider.id, provider]))
    const providers = await Promise.all(
      this.#context.llm.listConfigurableProviders().map(async (entry): Promise<ConfigurableLlmProviderView> => {
        const descriptor = descriptors.get(settingsNamespace(entry.settingsNs))
        if (!descriptor) throw new Error(`DSH 模型设置 namespace 未注册：${entry.settingsNs}`)
        const rawProfile = readObjectPath(descriptor.value, entry.settingsPath)
        const profile = rawProfile === undefined ? undefined : LlmProviderProfileSchema.parse(rawProfile)
        const configured = rawProfile !== undefined
        const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
        const credential =
          apiKeyEnv === undefined ? undefined : await this.#context.credentials.describe(credentialRef(apiKeyEnv))
        const configuredModels = Array.isArray(profile?.models)
          ? profile.models.flatMap((candidate) => {
              const result = ConfiguredLlmModelSchema.safeParse(candidate)
              if (!result.success) return []
              const model = result.data
              return [
                {
                  id: model.id,
                  name: model.name ?? model.id,
                  ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
                  ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
                },
              ]
            })
          : []
        const liveModels = active.has(entry.provider)
          ? (await this.#context.llm.listModels(entry.provider)).map((model) => ({ id: model.id, name: model.name }))
          : []
        return {
          provider: entry.provider,
          displayName: entry.displayName,
          settingsNs: entry.settingsNs,
          settingsPath: [...entry.settingsPath],
          settingsRevision: descriptor.revision,
          declared: entry.declared === true,
          active: active.has(entry.provider),
          configured,
          ...(typeof profile?.baseURL === 'string' ? { baseURL: profile.baseURL } : {}),
          ...(typeof profile?.api === 'string' ? { api: profile.api } : {}),
          ...(credential === undefined
            ? {}
            : {
                credential: {
                  configured: credential.configured,
                  writable: credential.writable,
                  ...(credential.source === undefined ? {} : { source: credential.source }),
                },
              }),
          models: configuredModels.length > 0 ? configuredModels : liveModels,
        }
      }),
    )
    return { writable: this.#context.settings.writable, protocols: [...LlmPiAi.supportedProtocols()], providers }
  }

  async getWebSearchCapabilityStatus(): Promise<WebSearchCapabilityStatus> {
    const fallback: WebSearchCapabilityStatus = {
      provider: 'deepseek-official',
      available: false,
      credentialConfigured: false,
      credentialReference: 'DEEPSEEK_API_KEY',
      maxUsesPerCall: 2,
      maxResultsPerCall: 5,
      timeoutMs: 60_000,
    }
    if (!this.#hasLlmSettings) return fallback
    const descriptor = this.#context.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === settingsNamespace('web-search-deepseek'))
    const valuesResult = WebSearchSettingsSchema.safeParse(descriptor?.value)
    const values = valuesResult.success ? valuesResult.data : undefined
    const credentialReference = typeof values?.apiKeyEnv === 'string' ? values.apiKeyEnv : fallback.credentialReference
    const credential = await this.#context.credentials.describe(credentialRef(credentialReference))
    const inlineSecretConfigured =
      descriptor?.secrets?.some((secret) => secret.set && secret.path.length === 1 && secret.path[0] === 'apiKey') ===
      true
    const credentialConfigured = credential.configured || inlineSecretConfigured
    return { ...fallback, available: credentialConfigured, credentialConfigured, credentialReference }
  }

  listDshPlugins(): readonly DshPluginCatalogEntry[] {
    const liveNamespaces = new Set(
      this.#hasLlmSettings
        ? this.#context.settings
            .describe({ redactSecrets: true })
            .filter((descriptor) => isDshSettingsSchemaWireSafe(descriptor.schema))
            .map((descriptor) => String(descriptor.ns))
        : [],
    )
    return DSH_BUILTIN_EXTENSION_ROSTER.map((entry) => {
      const expectedNamespaces = entry.settingsNamespaces ?? []
      return {
        packageName: entry.packageName,
        packageVersion: HOST_DSH_PACKAGE_VERSIONS[entry.packageName],
        origin: 'builtin',
        settingsNamespaces: expectedNamespaces.filter((ns) => liveNamespaces.has(ns)),
      }
    })
  }

  listDshSettings(): readonly DshSettingsNamespaceView[] {
    if (!this.#hasLlmSettings) return []
    return this.#context.settings
      .describe({ redactSecrets: true })
      .filter((descriptor) => isDshSettingsSchemaWireSafe(descriptor.schema))
      .map((descriptor) => this.#projectDshSettingsDescriptor(descriptor))
  }

  async mutateDshSettings(
    ns: string,
    expectedRevision: number,
    ops: readonly DshSettingsPathOperation[],
  ): Promise<DshSettingsNamespaceView> {
    if (!this.#hasLlmSettings) throw new Error('DSH 设置服务未启用。')
    const branded = settingsNamespace(ns)
    const before = this.#context.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === branded)
    if (!before) throw new Error(`DSH Settings namespace 不存在：${ns}`)
    if (!isDshSettingsSchemaWireSafe(before.schema)) {
      throw new Error(`DSH Settings namespace 含有 0.1.1-rc.2 无法安全脱敏的 Schema：${ns}`)
    }
    await this.#context.settings.mutate(branded, ops, expectedRevision)
    const descriptor = this.#context.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === branded)
    if (!descriptor) throw new Error(`DSH Settings namespace 在保存后已卸载：${ns}`)
    return this.#projectDshSettingsDescriptor(descriptor)
  }

  async describeDshCredentials(refs: readonly string[]): Promise<Readonly<Record<string, DshCredentialView>>> {
    if (!this.#hasLlmSettings) return {}
    return Object.fromEntries(
      await Promise.all(
        refs.map(async (ref) => {
          const info = await this.#context.credentials.describe(credentialRef(ref))
          return [ref, info] as const
        }),
      ),
    )
  }

  async setDshCredential(ref: string, value: string): Promise<DshCredentialView> {
    if (!this.#hasLlmSettings) throw new Error('DSH 凭据服务未启用。')
    const branded = credentialRef(ref)
    await this.#context.credentials.set(branded, value)
    return await this.#context.credentials.describe(branded)
  }

  async unsetDshCredential(ref: string): Promise<DshCredentialView> {
    if (!this.#hasLlmSettings) throw new Error('DSH 凭据服务未启用。')
    const branded = credentialRef(ref)
    await this.#context.credentials.unset(branded)
    return await this.#context.credentials.describe(branded)
  }

  onDshSettingsChanged(listener: (ns: string, revision: number) => void): () => void {
    return this.#context.on('settings/document-updated', (ns, revision) => {
      listener(String(ns), revision)
    })
  }

  onDshCredentialChanged(listener: (ref: string) => void): () => void {
    return this.#context.on('credentials/reference-updated', (ref) => {
      listener(String(ref))
    })
  }

  #projectDshSettingsDescriptor(
    descriptor: ReturnType<Context['settings']['describe']>[number],
  ): DshSettingsNamespaceView {
    const ns = String(descriptor.ns)
    const owner = DSH_SETTINGS_OWNER.get(ns)
    return {
      ns,
      schema: descriptor.schema,
      resolved: descriptor.value,
      ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
      ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
      applies: descriptor.applies,
      secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
      revision: descriptor.revision,
      writable: this.#context.settings.writable,
      ...(owner === undefined
        ? {}
        : { owner: { packageName: owner, packageVersion: HOST_DSH_PACKAGE_VERSIONS[owner] } }),
    }
  }

  async saveLlmProvider(input: SaveLlmProviderInput): Promise<LlmProviderSettingsView> {
    if (!this.#hasLlmSettings) throw new Error('DSH 模型设置服务未启用。')
    if (!/^[a-z][a-z0-9-]*$/u.test(input.provider)) throw new Error('Provider ID 必须以小写字母开头。')
    const directory = this.#context.llm.listConfigurableProviders()
    const entry = directory.find((candidate) => candidate.provider === input.provider)
    const settingsNs = entry?.settingsNs ?? 'llm-pi-ai'
    const settingsPath = entry?.settingsPath ?? ['providers', input.provider]
    const descriptor = this.#context.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === settingsNamespace(settingsNs))
    if (!descriptor) throw new Error(`DSH 模型设置 namespace 未注册：${settingsNs}`)
    const rawCurrent = readObjectPath(descriptor.value, settingsPath)
    const current = rawCurrent === undefined ? undefined : LlmProviderProfileSchema.parse(rawCurrent)
    const credentialRefName =
      typeof current?.apiKeyEnv === 'string' ? current.apiKeyEnv : credentialReferenceForProvider(input.provider)
    const fields: Record<string, unknown> = {}
    if (input.displayName !== undefined) fields['displayName'] = input.displayName
    if (input.baseURL !== undefined) fields['baseURL'] = input.baseURL
    if (input.api !== undefined) fields['api'] = input.api
    if (input.models !== undefined) fields['models'] = input.models.map((model) => ({ ...model }))
    if (input.apiKey !== undefined || typeof current?.apiKeyEnv === 'string') fields['apiKeyEnv'] = credentialRefName
    if (entry === undefined) {
      if (!input.displayName || !input.baseURL || !input.api || !input.models?.length) {
        throw new Error('自定义供应商需要名称、API 地址、协议和至少一个模型。')
      }
    }
    const ops: SettingsPathOp[] =
      current === undefined
        ? [{ op: 'set', path: settingsPath, value: fields }]
        : Object.entries(fields).map(([key, value]) => ({ op: 'set' as const, path: [...settingsPath, key], value }))
    if (ops.length === 0 && current === undefined) ops.push({ op: 'set', path: settingsPath, value: {} })
    if (ops.length > 0) {
      await this.#context.settings.mutate(settingsNamespace(settingsNs), ops, input.expectedRevision)
    }
    if (input.apiKey !== undefined) {
      await this.#context.credentials.set(credentialRef(credentialRefName), input.apiKey)
    }
    return this.getLlmProviderSettings()
  }

  async discoverLlmProviderModels(input: {
    readonly provider?: string
    readonly settingsNs?: string
    readonly baseURL?: string
    readonly api?: string
    readonly apiKey?: string
  }): Promise<
    readonly {
      readonly id: string
      readonly name?: string
      readonly contextWindow?: number
      readonly maxTokens?: number
    }[]
  > {
    const settingsNs =
      input.settingsNs ??
      this.#context.llm.listConfigurableProviders().find((entry) => entry.provider === input.provider)?.settingsNs ??
      'llm-pi-ai'
    return this.#context.llm.discoverModels(settingsNs, input)
  }

  async testLlmProvider(input: TestLlmProviderInput): Promise<{ readonly provider: string; readonly model: string }> {
    const hasDraft =
      input.settingsNs !== undefined ||
      input.apiKey !== undefined ||
      input.baseURL !== undefined ||
      input.api !== undefined ||
      input.models !== undefined
    if (!hasDraft) {
      await this.#runLlmConnectionProbe(this.#context.llm, input.provider, input.model)
      return { provider: input.provider, model: input.model }
    }
    if (!this.#hasLlmSettings) throw new Error('DSH 模型设置服务未启用。')
    const directoryEntry = this.#context.llm
      .listConfigurableProviders()
      .find((candidate) => candidate.provider === input.provider)
    const settingsNs = input.settingsNs ?? directoryEntry?.settingsNs ?? 'llm-pi-ai'
    if (settingsNs !== 'llm-pi-ai') throw new Error(`当前不支持测试此模型适配器：${settingsNs}`)
    const descriptor = this.#context.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === settingsNamespace(settingsNs))
    if (!descriptor) throw new Error(`DSH 模型设置 namespace 未注册：${settingsNs}`)
    const settingsPath = directoryEntry?.settingsPath ?? ['providers', input.provider]
    const rawCurrent = readObjectPath(descriptor.value, settingsPath)
    const current = rawCurrent === undefined ? {} : LlmProviderProfileSchema.parse(rawCurrent)
    const profile: Record<string, unknown> = { ...current }
    if (input.baseURL !== undefined) profile['baseURL'] = input.baseURL
    if (input.api !== undefined) profile['api'] = input.api
    if (input.models !== undefined) profile['models'] = input.models.map((model) => ({ ...model }))

    const storedRef = typeof current['apiKeyEnv'] === 'string' ? current['apiKeyEnv'] : undefined
    const storedApiKey =
      input.apiKey === undefined && storedRef !== undefined
        ? (await this.#context.credentials.resolve(credentialRef(storedRef)))?.value
        : undefined
    const draftApiKey = input.apiKey ?? storedApiKey
    if (input.apiKey !== undefined || storedRef !== undefined) profile['apiKeyEnv'] = DRAFT_LLM_CREDENTIAL_REF

    const draftContext = new Context()
    try {
      await draftContext.plugin(DraftLlmCredentialProvider, {
        ...(draftApiKey === undefined ? {} : { apiKey: draftApiKey }),
      })
      await draftContext.plugin(LlmRuntime)
      await draftContext.plugin(LlmPiAi, {
        // The saved section was already validated by DSH; this isolated plugin validates the merged draft again.
        providers: { [input.provider]: profile },
      })
      await this.#runLlmConnectionProbe(draftContext.llm, input.provider, input.model)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (draftApiKey && message.includes(draftApiKey)) throw new Error('模型供应商连接测试失败。')
      throw cause
    } finally {
      await draftContext.fiber.dispose()
    }
    return { provider: input.provider, model: input.model }
  }

  async #runLlmConnectionProbe(llm: Pick<LlmRuntime, 'stream'>, provider: string, model: string): Promise<void> {
    let finished = false
    for await (const chunk of llm.stream({
      provider,
      model,
      system: '这是一次连接测试。请只回复 OK。',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'OK' }], source: { kind: 'user' } })],
      maxTokens: 16,
    })) {
      if (chunk.type !== 'finish') continue
      finished = true
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        const code = chunk.reason.failure.code
        if (code === 'AUTH' || code === 'MISSING_CREDENTIAL') throw new Error('认证失败，请更新 API 密钥。')
        if (code === 'QUOTA') throw new Error('供应商额度不足或订阅限制。')
        if (code === 'RATE_LIMIT') throw new Error('供应商限流，请稍后再试。')
        throw new Error(`模型请求失败（${code}）：${chunk.reason.failure.message}`)
      }
    }
    if (!finished) throw new Error('供应商没有返回完整结果。')
  }
}
