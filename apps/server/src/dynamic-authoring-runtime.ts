import type { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import DynamicCordisRunnerService, {
  ApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  type CordisDynamicRunMode,
  type CordisErrorDetails,
  type DynamicCordisClientSource,
  type DynamicCordisDefineReceipt,
  type DynamicCordisDefineRequest,
  type DynamicCordisHostHalfResult,
  type DynamicCordisInventoryRow,
  type DynamicCordisInvokeResult,
  type DynamicCordisPackageInspection,
  type DynamicCordisPluginInspection,
  type DynamicCordisReference,
  type DynamicCordisRenderFailure,
  type DynamicCordisResolveAck,
  type DynamicCordisRunResolution,
  type DynamicCordisRunResponse,
  type DynamicCordisSnapshotRow,
  type DynamicCordisStopResponse,
  type DynamicCordisUndefineReceipt,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { CallId, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  type AdapterClientSlotName,
  type AgentClientSlotName,
  type AgentId,
  type AuthoringTaskId,
  type ChannelId,
  type EpisodeId,
  type HostPageContribution,
  type HostUiKitComponentName,
  type HostUiPageGeometryEvidence,
  type HostUiPermissionDeclaration,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { AgentRevisionRecord } from '@nekro-nxt/core'
import { canonicalJson } from '@nekro-nxt/core'
import {
  scopeHostUiCss,
  validateHostUiCss,
  validateHostUiSvg,
  type DynamicAuthoringService,
  type DynamicAuthoringSnapshot,
} from '@nekro-nxt/extension-runtime'
import { createHash } from 'node:crypto'
import {
  ADAPTER_DYNAMIC_EVIDENCE_METHOD,
  AdapterDynamicEvidenceSchema,
  isLegacyAdapterDynamicHostSource,
  wrapAdapterDynamicHostSource,
} from './adapter-dynamic-harness.js'
import { EXTENSION_PRIVATE_SERVICE_KEY_SET } from './extension-context.js'
import type { DshHostRuntimeOptions } from './index.js'
import type { SessionRegistry } from './session-registry.js'
export type CordisDynamicPackageIdType = ReturnType<typeof CordisDynamicPackageId>

export type CordisDynamicPluginIdType = ReturnType<typeof CordisDynamicPluginId>

export type ApprovalRequestIdType = ReturnType<typeof ApprovalRequestId>

export interface DynamicPackageDefinitionInput {
  readonly plugin:
    | { readonly kind: 'new'; readonly idPrefix: string }
    | {
        readonly kind: 'existing'
        readonly pluginId: string
      }
  readonly name: string
  readonly purpose: string
  readonly code: { readonly host?: string; readonly client?: string }
}

export interface DynamicAuthoringPackageDefinitionInput extends DynamicPackageDefinitionInput {
  readonly scope: DynamicAuthoringSnapshot['scope']
  readonly resources: Readonly<Record<string, string>>
  readonly clientCss?: { readonly path: string; readonly sha256: string }
  readonly permissions: HostUiPermissionDeclaration
  readonly contributions: readonly JsonValue[]
}

export interface DynamicAuthoringPolicyState {
  readonly episodeId: EpisodeId
  readonly turn: number
  readonly primaryPluginId?: string
  readonly consecutiveFailures: number
  readonly repeatedFingerprintCount: number
  readonly lastErrorFingerprint?: string
  readonly blockedReason?: string
}

export interface DynamicApprovalRequestEvent {
  readonly requestId: string
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly pluginId: string
  readonly packageId: string
  readonly name: string
  readonly purpose: string
}

export const normalizeDynamicFailure = (phase: string, message: string): string =>
  `${phase}:${message}`
    .toLowerCase()
    .replace(/[a-z]{3,6}-\d+|package-\d+|run-\d+/gu, '<id>')
    .replace(/\s+/gu, ' ')
    .trim()

export const preflightNekroNxtAuthoringDefinition = (
  input: DynamicAuthoringPackageDefinitionInput,
): DynamicAuthoringPackageDefinitionInput => {
  const resourceEntries = Object.entries(input.resources)
  const resourcePaths = new Set(resourceEntries.map(([resourcePath]) => resourcePath))
  if (resourcePaths.size !== resourceEntries.length) throw new Error('动态页面预检失败：资源路径不能重复。')
  if (input.contributions.length > 8) throw new Error('动态页面预检失败：一个 Revision 最多声明 8 个页面入口。')
  const pages = input.contributions.map((contribution) => HostPageContributionSchema.parse(contribution))
  if (new Set(pages.map(({ entryId }) => entryId)).size !== pages.length) {
    throw new Error('动态页面预检失败：页面 entryId 不能重复。')
  }
  HostUiPermissionDeclarationSchema.parse(input.permissions)
  if (pages.length === 0 && (input.permissions.permissions.length > 0 || input.permissions.networkOrigins.length > 0)) {
    throw new Error('动态页面预检失败：没有页面贡献时不能声明 Host UI 权限。')
  }
  if (input.scope === 'host-ui' && pages.length === 0) {
    throw new Error('动态页面预检失败：host-ui 候选必须声明至少一个页面入口。')
  }
  if (input.scope === 'agent' && pages.length > 0) {
    throw new Error('动态页面预检失败：智能体候选不能贡献顶级页面。')
  }
  if (input.scope === 'host-adapter' && input.code.host === undefined) {
    throw new Error('动态 Adapter 预检失败：host-adapter 候选必须包含 Host 源码。')
  }
  if (
    (pages.length > 0 || resourceEntries.length > 0 || input.clientCss !== undefined) &&
    input.code.client === undefined
  ) {
    throw new Error('动态页面预检失败：页面声明和 Client 资源必须配套 Client 源码。')
  }
  const referencedResources = new Set<string>()
  if (input.clientCss) {
    const source = input.resources[input.clientCss.path]
    if (source === undefined) throw new Error(`动态页面预检失败：缺少 CSS 资源 ${input.clientCss.path}。`)
    const actualDigest = createHash('sha256').update(source).digest('hex')
    if (actualDigest !== input.clientCss.sha256)
      throw new Error(`动态页面预检失败：CSS 摘要不匹配 ${input.clientCss.path}。`)
    validateHostUiCss(source)
    referencedResources.add(input.clientCss.path)
  }
  for (const page of pages) {
    if (page.icon.kind !== 'svg') continue
    const source = input.resources[page.icon.path]
    if (source === undefined) throw new Error(`动态页面预检失败：缺少图标资源 ${page.icon.path}。`)
    const actualDigest = createHash('sha256').update(source).digest('hex')
    if (actualDigest !== page.icon.sha256) throw new Error(`动态页面预检失败：SVG 摘要不匹配 ${page.icon.path}。`)
    validateHostUiSvg(source)
    referencedResources.add(page.icon.path)
  }
  for (const [resourcePath] of resourceEntries) {
    if (!referencedResources.has(resourcePath)) {
      throw new Error(`动态页面预检失败：资源没有被 CSS 或页面图标声明引用：${resourcePath}。`)
    }
  }
  return input
}

export const dynamicPreviewClientCode = (input: DynamicAuthoringPackageDefinitionInput): string | undefined => {
  const source = input.code.client
  if (source === undefined || input.clientCss === undefined) return source
  const css = input.resources[input.clientCss.path]
  if (css === undefined) throw new Error(`动态页面预览缺少 CSS 资源 ${input.clientCss.path}。`)
  return `styles.insert(${JSON.stringify(scopeHostUiCss(css, 'dynamic-preview'))})\n${source}`
}

export const preflightNekroNxtDynamicSource = (request: DynamicCordisDefineRequest): void => {
  const client = request.code.client
  if (client === undefined) return
  const registersPages = /\b(?:ctx\.)?pages\s*\.\s*(?:register|declarePermissions)\b/u.test(client)
  const injectsPages = /\binject\s*:\s*\[[^\]]*['"]pages['"][^\]]*\]/su.test(client)
  if (registersPages && !injectsPages) {
    throw new Error("动态页面预检失败：Client 使用了 pages Service，但没有声明 inject: ['pages']。")
  }
  const absolutePagePath = /\b(?:startPath|path)\s*:\s*['"]\//u.exec(client)
  if (absolutePagePath) {
    throw new Error('动态页面预检失败：startPath、导航 path 和 navigate() 必须使用入口内相对路径，不能以 / 开头。')
  }
}

export class NekroNxtDynamicCordisRunner extends DynamicCordisRunnerService {
  private state: DynamicAuthoringPolicyState | undefined
  private readonly runtimeContext: Context
  private readonly toolNamesByPackage = new Map<string, readonly string[]>()
  private readonly clientEvidenceByPackage = new Map<
    string,
    {
      readonly pluginRunId: string
      readonly renderedSlots: readonly AgentClientSlotName[]
      readonly renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[]
      readonly renderedPages: readonly HostPageContribution[]
      readonly usedUiComponents: readonly HostUiKitComponentName[]
      readonly pageGeometry: readonly HostUiPageGeometryEvidence[]
      readonly navigationEntries: readonly string[]
      readonly permissions: HostUiPermissionDeclaration
    }
  >()
  private readonly clientRpcMethodsByPackage = new Map<
    string,
    { readonly pluginRunId: string; readonly methods: Set<string> }
  >()
  private readonly adapterPackages = new Set<string>()
  private readonly originalHostByPackage = new Map<string, string>()
  private readonly authoringPersistenceByPackage = new Map<string, Promise<void>>()
  private authoringPersistenceTail: Promise<void> = Promise.resolve()
  private definingAuthoringSnapshot: DynamicAuthoringSnapshot | undefined
  private suppressAuthoringPersistence = false
  private onAuthoringDefinition:
    | ((
        request: DynamicCordisDefineRequest,
        receipt: DynamicCordisDefineReceipt,
        snapshot: DynamicAuthoringSnapshot,
      ) => Promise<void>)
    | undefined
  private onAuthoringRun:
    ((pluginId: string, packageId: string, result: DynamicCordisRunResponse) => Promise<void>) | undefined
  private rootSessionId: SessionId | undefined
  private ownerResolver: ((agent: Agent) => Agent) | undefined
  private sessionOwnerResolver: ((sessionId: SessionId) => Agent) | undefined

  constructor(context: Context, config: { readonly vmTimeoutMs?: number }) {
    super(context, config)
    this.runtimeContext = context
  }

  bindEpisode(episodeId: EpisodeId): void {
    if (this.state && this.state.episodeId !== episodeId) throw new Error('Dynamic Runner crossed Episode ownership.')
    this.state ??= {
      episodeId,
      turn: 0,
      consecutiveFailures: 0,
      repeatedFingerprintCount: 0,
    }
  }

  configureDynamicAuthoringOwner(input: {
    readonly rootSessionId: SessionId
    readonly resolveAgent: (agent: Agent) => Agent
    readonly resolveSession: (sessionId: SessionId) => Agent
  }): void {
    if (this.rootSessionId !== undefined && this.rootSessionId !== input.rootSessionId) {
      throw new Error('Dynamic Runner crossed root Session ownership.')
    }
    this.rootSessionId = input.rootSessionId
    this.ownerResolver = input.resolveAgent
    this.sessionOwnerResolver = input.resolveSession
  }

  resolveDynamicAuthoringOwner(agent: Agent): Agent {
    const rootSessionId = this.requireRootSessionId()
    if (agent.id === rootSessionId) return agent
    if (!this.ownerResolver) throw new Error('Dynamic authoring owner resolver is unavailable.')
    return this.ownerResolver(agent)
  }

  configureAuthoringLedger(callbacks: {
    readonly definition: (
      request: DynamicCordisDefineRequest,
      receipt: DynamicCordisDefineReceipt,
      snapshot: DynamicAuthoringSnapshot,
    ) => Promise<void>
    readonly run: (pluginId: string, packageId: string, result: DynamicCordisRunResponse) => Promise<void>
  }): void {
    this.onAuthoringDefinition = callbacks.definition
    this.onAuthoringRun = callbacks.run
  }

  defineAuthoringPackage(sessionId: string, input: DynamicAuthoringPackageDefinitionInput): DynamicCordisDefineReceipt {
    const parsed = preflightNekroNxtAuthoringDefinition(input)
    const previewClient = dynamicPreviewClientCode(parsed)
    const request: DynamicCordisDefineRequest = {
      sessionId: SessionId(sessionId),
      plugin:
        parsed.plugin.kind === 'new'
          ? { kind: 'new', idPrefix: parsed.plugin.idPrefix }
          : { kind: 'existing', pluginId: CordisDynamicPluginId(parsed.plugin.pluginId) },
      name: parsed.name,
      purpose: parsed.purpose,
      code: {
        ...(parsed.code.host === undefined ? {} : { host: parsed.code.host }),
        ...(previewClient === undefined ? {} : { client: previewClient }),
      },
    }
    this.definingAuthoringSnapshot = {
      name: parsed.name,
      purpose: parsed.purpose,
      scope: parsed.scope,
      code: parsed.code,
      resources: parsed.resources,
      ...(parsed.clientCss === undefined ? {} : { clientCss: parsed.clientCss }),
      permissions: parsed.permissions,
      contributions: parsed.contributions,
    }
    try {
      return this.define(request)
    } finally {
      this.definingAuthoringSnapshot = undefined
    }
  }

  restoreAuthoringPackage(sessionId: string, snapshot: DynamicAuthoringSnapshot): DynamicCordisDefineReceipt {
    preflightNekroNxtAuthoringDefinition({
      plugin: { kind: 'new', idPrefix: 'rest' },
      name: snapshot.name,
      purpose: snapshot.purpose,
      scope: snapshot.scope,
      code: snapshot.code,
      resources: snapshot.resources,
      ...(snapshot.clientCss === undefined ? {} : { clientCss: snapshot.clientCss }),
      permissions: snapshot.permissions,
      contributions: snapshot.contributions,
    })
    const previewClient = dynamicPreviewClientCode({
      plugin: { kind: 'new', idPrefix: 'rest' },
      name: snapshot.name,
      purpose: snapshot.purpose,
      scope: snapshot.scope,
      code: snapshot.code,
      resources: snapshot.resources,
      ...(snapshot.clientCss === undefined ? {} : { clientCss: snapshot.clientCss }),
      permissions: snapshot.permissions,
      contributions: snapshot.contributions,
    })
    const code = {
      ...(snapshot.code.host === undefined ? {} : { host: snapshot.code.host }),
      ...(previewClient === undefined ? {} : { client: previewClient }),
    }
    this.suppressAuthoringPersistence = true
    this.definingAuthoringSnapshot = snapshot
    try {
      return this.define({
        sessionId: SessionId(sessionId),
        plugin: { kind: 'new', idPrefix: 'rest' },
        name: snapshot.name,
        purpose: snapshot.purpose,
        code,
      })
    } finally {
      this.definingAuthoringSnapshot = undefined
      this.suppressAuthoringPersistence = false
    }
  }

  beginOrdinaryTurn(): void {
    const state = this.requireState()
    this.state = {
      episodeId: state.episodeId,
      turn: state.turn + 1,
      ...(state.primaryPluginId === undefined ? {} : { primaryPluginId: state.primaryPluginId }),
      consecutiveFailures: 0,
      repeatedFingerprintCount: 0,
    }
  }

  policySnapshot(): DynamicAuthoringPolicyState {
    return { ...this.requireState() }
  }

  override define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt {
    const ownedRequest = this.normalizeDefineRequest(request)
    this.assertWritable('define')
    preflightNekroNxtDynamicSource(ownedRequest)
    const state = this.requireState()
    if (ownedRequest.plugin.kind === 'new' && state.primaryPluginId !== undefined) {
      throw new Error(`当前 Episode 已拥有 Plugin ${state.primaryPluginId}；修复必须使用 kind:existing。`)
    }
    if (ownedRequest.plugin.kind === 'existing' && ownedRequest.plugin.pluginId !== state.primaryPluginId) {
      throw new Error(`只能向当前 Episode 的 Plugin ${state.primaryPluginId ?? '（尚未创建）'} 追加 Package。`)
    }
    try {
      const adapterHost =
        this.definingAuthoringSnapshot?.scope === 'host-adapter'
          ? ownedRequest.code.host
          : this.definingAuthoringSnapshot === undefined && isLegacyAdapterDynamicHostSource(ownedRequest.code.host)
            ? ownedRequest.code.host
            : undefined
      const receipt = super.define(
        adapterHost === undefined
          ? ownedRequest
          : {
              ...ownedRequest,
              code: { ...ownedRequest.code, host: wrapAdapterDynamicHostSource(adapterHost) },
            },
      )
      if (adapterHost !== undefined) {
        this.adapterPackages.add(receipt.packageId)
        this.originalHostByPackage.set(receipt.packageId, adapterHost)
      }
      if (ownedRequest.plugin.kind === 'new') this.state = { ...state, primaryPluginId: receipt.pluginId }
      if (this.onAuthoringDefinition && !this.suppressAuthoringPersistence) {
        const persistDefinition = this.onAuthoringDefinition
        const snapshot = this.definingAuthoringSnapshot ?? {
          name: ownedRequest.name,
          purpose: ownedRequest.purpose,
          scope: adapterHost === undefined ? 'agent' : 'host-adapter',
          code: ownedRequest.code,
          resources: {},
          permissions: { permissions: [], networkOrigins: [] },
          contributions: [],
        }
        const persistence = this.authoringPersistenceTail.then(() => persistDefinition(ownedRequest, receipt, snapshot))
        this.authoringPersistenceTail = persistence.catch(() => undefined)
        this.authoringPersistenceByPackage.set(receipt.packageId, persistence)
        void persistence.catch((error: unknown) => {
          console.error('[nekro-nxt] 动态创造账本写入失败：', error)
        })
      }
      return receipt
    } catch (error) {
      this.recordFailure('define', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  override inspectPackage(
    agent: Agent,
    pluginId: CordisDynamicPluginIdType,
    packageId: CordisDynamicPackageIdType,
  ): DynamicCordisPackageInspection {
    const inspection = super.inspectPackage(this.resolveDynamicAuthoringOwner(agent), pluginId, packageId)
    const originalHost = this.originalHostByPackage.get(packageId)
    if (originalHost === undefined) return inspection
    return { ...inspection, code: { ...inspection.code, host: originalHost } }
  }

  isAdapterPackage(packageId: string): boolean {
    return this.adapterPackages.has(packageId)
  }

  override async run(
    agent: Agent,
    pluginId: CordisDynamicPluginIdType,
    packageId: CordisDynamicPackageIdType,
    mode: CordisDynamicRunMode,
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponse> {
    const owner = this.resolveDynamicAuthoringOwner(agent)
    this.assertWritable('run')
    await this.authoringPersistenceByPackage.get(packageId)
    const tools = this.runtimeContext.get('tools')
    const before =
      tools instanceof ToolRuntime ? new Set(tools.schemas(scopeOf(owner.ctx)).map(({ name }) => name)) : new Set()
    const result = await super.run(owner, pluginId, packageId, mode, signal)
    if (result.ok && result.status === 'running') {
      if (tools instanceof ToolRuntime) {
        this.toolNamesByPackage.set(
          packageId,
          tools
            .schemas(scopeOf(owner.ctx))
            .map(({ name }) => name)
            .filter((name) => !before.has(name)),
        )
      }
      const privateServices = result.waitingFor.filter((service) => EXTENSION_PRIVATE_SERVICE_KEY_SET.has(service))
      if (privateServices.length > 0) {
        this.recordFailure(
          'private-service',
          `Dynamic Extension requested a private Host Service: ${privateServices.join(', ')}`,
        )
      } else {
        this.clearFailures()
      }
    } else if (!result.ok) this.recordFailure(result.reason, result.message)
    await this.onAuthoringRun?.(pluginId, packageId, result)
    return result
  }

  verificationSnapshot(
    agent: Agent,
    pluginId: string,
    packageId: string,
  ): {
    readonly pluginRunId: string
    readonly toolNames: readonly string[]
    readonly rpcMethods: readonly string[]
    readonly renderedSlots: readonly AgentClientSlotName[]
    readonly renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[]
    readonly renderedPages: readonly HostPageContribution[]
    readonly usedUiComponents: readonly HostUiKitComponentName[]
    readonly pageGeometry: readonly HostUiPageGeometryEvidence[]
    readonly navigationEntries: readonly string[]
    readonly permissions: HostUiPermissionDeclaration
  } {
    const row = this.snapshot(agent).find((candidate) => candidate.pluginId === pluginId)
    if (row?.activeRun?.packageId !== packageId) throw new Error('Dynamic Package is not the active verified Run.')
    const pkg = row.packages.find((candidate) => candidate.packageId === packageId)
    const clientEvidence = this.clientEvidenceByPackage.get(packageId)
    if (pkg?.hasClientHalf && clientEvidence?.pluginRunId !== row.activeRun.pluginRunId) {
      throw new Error('Dynamic Client half has not rendered in a NekroNxt product Slot for this Run.')
    }
    const clientRpcEvidence = this.clientRpcMethodsByPackage.get(packageId)
    const clientRpcMethods =
      clientRpcEvidence?.pluginRunId === row.activeRun.pluginRunId ? clientRpcEvidence.methods : new Set<string>()
    const clientCallableHandlers = this.isAdapterPackage(packageId)
      ? row.activeRun.handlers.filter((method) => method !== ADAPTER_DYNAMIC_EVIDENCE_METHOD)
      : row.activeRun.handlers
    if (pkg?.hasClientHalf && clientCallableHandlers.some((method) => !clientRpcMethods.has(method))) {
      throw new Error('Dynamic Client preview has not called every registered Host RPC for this Run.')
    }
    return {
      pluginRunId: row.activeRun.pluginRunId,
      toolNames: this.toolNamesByPackage.get(packageId) ?? [],
      rpcMethods: row.activeRun.handlers,
      renderedSlots: clientEvidence?.renderedSlots ?? [],
      renderedHostSlots: clientEvidence?.renderedHostSlots ?? [],
      renderedPages: clientEvidence?.renderedPages ?? [],
      usedUiComponents: clientEvidence?.usedUiComponents ?? [],
      pageGeometry: clientEvidence?.pageGeometry ?? [],
      navigationEntries: clientEvidence?.navigationEntries ?? [],
      permissions: clientEvidence?.permissions ?? { permissions: [], networkOrigins: [] },
    }
  }

  recordClientVerification(
    agent: Agent,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    renderedSlots: readonly AgentClientSlotName[],
    renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[],
    renderedPages: readonly HostPageContribution[],
    usedUiComponents: readonly HostUiKitComponentName[],
    pageGeometry: readonly HostUiPageGeometryEvidence[],
    navigationEntries: readonly string[],
    permissions: HostUiPermissionDeclaration,
  ): void {
    const row = this.snapshot(agent).find((candidate) => candidate.pluginId === pluginId)
    if (row?.activeRun?.packageId !== packageId || row.activeRun.pluginRunId !== pluginRunId) {
      throw new Error('Dynamic Client verification does not match the active Package Run.')
    }
    const pkg = row.packages.find((candidate) => candidate.packageId === packageId)
    if (!pkg?.hasClientHalf) throw new Error('Host-only Package cannot report Client verification.')
    if (renderedSlots.length === 0 && renderedHostSlots.length === 0 && renderedPages.length === 0) {
      throw new Error('Dynamic Client verification must contain a product Slot or page.')
    }
    this.clientEvidenceByPackage.set(packageId, {
      pluginRunId,
      renderedSlots: [...new Set(renderedSlots)],
      renderedHostSlots: [...new Map(renderedHostSlots.map((slot) => [slot.key, slot])).values()],
      renderedPages,
      usedUiComponents: [...new Set(usedUiComponents)],
      pageGeometry,
      navigationEntries: [...new Set(navigationEntries)],
      permissions,
    })
  }

  recordClientRpcInvocation(agent: Agent, pluginId: string, pluginRunId: string, method: string): void {
    const row = this.snapshot(agent).find((candidate) => candidate.pluginId === pluginId)
    if (!row?.activeRun || row.activeRun.pluginRunId !== pluginRunId || !row.activeRun.handlers.includes(method)) {
      throw new Error('Dynamic Client RPC evidence does not match the active Package Run.')
    }
    const current = this.clientRpcMethodsByPackage.get(row.activeRun.packageId)
    if (current?.pluginRunId === pluginRunId) current.methods.add(method)
    else this.clientRpcMethodsByPackage.set(row.activeRun.packageId, { pluginRunId, methods: new Set([method]) })
  }

  override async runHostHalf(
    agent: Agent,
    pluginId: CordisDynamicPluginIdType,
    packageId: CordisDynamicPackageIdType,
    mode: CordisDynamicRunMode,
    requestId: ApprovalRequestIdType | null,
    approveFutureVersions: boolean,
  ): Promise<DynamicCordisHostHalfResult> {
    const owner = this.resolveDynamicAuthoringOwner(agent)
    this.assertWritable('run-host-half')
    const tools = this.runtimeContext.get('tools')
    const before =
      tools instanceof ToolRuntime ? new Set(tools.schemas(scopeOf(owner.ctx)).map(({ name }) => name)) : new Set()
    const result = await super.runHostHalf(owner, pluginId, packageId, mode, requestId, approveFutureVersions)
    if (!result.ok) {
      this.recordFailure('host-half', result.message)
      return result
    }
    if (tools instanceof ToolRuntime && result.startedHere) {
      this.toolNamesByPackage.set(
        packageId,
        tools
          .schemas(scopeOf(owner.ctx))
          .map(({ name }) => name)
          .filter((name) => !before.has(name)),
      )
    }
    return result
  }

  override async undefine(agent: Agent, pluginId: CordisDynamicPluginIdType): Promise<DynamicCordisUndefineReceipt> {
    const owner = this.resolveDynamicAuthoringOwner(agent)
    const packages = this.snapshot(owner).find((candidate) => candidate.pluginId === pluginId)?.packages ?? []
    const result = await super.undefine(owner, pluginId)
    if (result.ok) {
      for (const pkg of packages) {
        this.toolNamesByPackage.delete(pkg.packageId)
        this.clientEvidenceByPackage.delete(pkg.packageId)
        this.clientRpcMethodsByPackage.delete(pkg.packageId)
        this.adapterPackages.delete(pkg.packageId)
        this.originalHostByPackage.delete(pkg.packageId)
      }
    }
    const state = this.requireState()
    if (result.ok && state.primaryPluginId === pluginId) {
      this.state = {
        episodeId: state.episodeId,
        turn: state.turn,
        consecutiveFailures: 0,
        repeatedFingerprintCount: 0,
      }
    }
    return result
  }

  override listPlugins(agent: Agent): DynamicCordisPluginInspection[] {
    return super.listPlugins(this.resolveDynamicAuthoringOwner(agent))
  }

  override inspectPlugin(agent: Agent, pluginId: CordisDynamicPluginIdType): DynamicCordisPluginInspection {
    return super.inspectPlugin(this.resolveDynamicAuthoringOwner(agent), pluginId)
  }

  override snapshot(agent: Agent): DynamicCordisSnapshotRow[] {
    return super.snapshot(this.resolveDynamicAuthoringOwner(agent))
  }

  override reference(agent: Agent, pluginId: CordisDynamicPluginIdType): DynamicCordisReference | undefined {
    return super.reference(this.resolveDynamicAuthoringOwner(agent), pluginId)
  }

  override stop(agent: Agent, pluginId: CordisDynamicPluginIdType): Promise<DynamicCordisStopResponse> {
    return super.stop(this.resolveDynamicAuthoringOwner(agent), pluginId)
  }

  private recordFailure(phase: string, message: string): void {
    const state = this.requireState()
    const fingerprint = normalizeDynamicFailure(phase, message)
    const repeated = state.lastErrorFingerprint === fingerprint ? state.repeatedFingerprintCount + 1 : 1
    const consecutive = state.consecutiveFailures + 1
    const blockedReason =
      repeated >= 2
        ? '相同动态扩展错误已连续出现两次，请停止修改并向用户报告诊断。'
        : consecutive >= 3
          ? '本轮动态扩展已连续失败三次，请停止修改并向用户报告诊断。'
          : undefined
    this.state = {
      ...state,
      consecutiveFailures: consecutive,
      repeatedFingerprintCount: repeated,
      lastErrorFingerprint: fingerprint,
      ...(blockedReason === undefined ? {} : { blockedReason }),
    }
  }

  private clearFailures(): void {
    const state = this.requireState()
    this.state = {
      episodeId: state.episodeId,
      turn: state.turn,
      ...(state.primaryPluginId === undefined ? {} : { primaryPluginId: state.primaryPluginId }),
      consecutiveFailures: 0,
      repeatedFingerprintCount: 0,
    }
  }

  private assertWritable(operation: string): void {
    const blockedReason = this.requireState().blockedReason
    if (blockedReason) throw new Error(`动态创造已熔断，拒绝 ${operation}：${blockedReason}`)
  }

  private requireState(): DynamicAuthoringPolicyState {
    if (!this.state) throw new Error('Dynamic authoring policy is not bound to an Episode.')
    return this.state
  }

  private requireRootSessionId(): SessionId {
    if (this.rootSessionId === undefined) throw new Error('Dynamic authoring root Session is not configured.')
    return this.rootSessionId
  }

  private normalizeDefineRequest(request: DynamicCordisDefineRequest): DynamicCordisDefineRequest {
    const rootSessionId = this.requireRootSessionId()
    if (request.sessionId === rootSessionId) return request
    if (!this.sessionOwnerResolver) throw new Error('Dynamic authoring Session owner resolver is unavailable.')
    const owner = this.sessionOwnerResolver(request.sessionId)
    if (owner.id !== rootSessionId) throw new Error('Dynamic authoring Session resolved to the wrong root owner.')
    return { ...request, sessionId: rootSessionId }
  }
}
export class DynamicAuthoringRuntime {
  readonly #context: Context
  readonly #sessions: SessionRegistry<{ readonly context: Context; readonly runner: NekroNxtDynamicCordisRunner }>
  readonly #authoring: DshHostRuntimeOptions['authoring']
  readonly #assertActive: () => void
  readonly #authoringContinuationIds = new Set<string>()
  readonly #authoringContinuationPending = new Map<string, Promise<void>>()
  readonly #dynamicApprovalListeners = new Set<(event: DynamicApprovalRequestEvent) => void>()
  constructor(
    context: Context,
    sessions: SessionRegistry<{ readonly context: Context; readonly runner: NekroNxtDynamicCordisRunner }>,
    authoring: DshHostRuntimeOptions['authoring'],
    assertActive: () => void,
  ) {
    this.#context = context
    this.#sessions = sessions
    this.#authoring = authoring
    this.#assertActive = assertActive
  }
  publishApproval(event: DynamicApprovalRequestEvent): void {
    for (const listener of this.#dynamicApprovalListeners) {
      try {
        listener(event)
      } catch {
        /* Observers cannot interrupt approval. */
      }
    }
  }
  clearObservers(): void {
    this.#dynamicApprovalListeners.clear()
  }
  async whenAuthoringSettled(dshSessionId: string): Promise<void> {
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    const continuationPrefix = `${agent.id}:`
    for (let round = 0; round < 16; round += 1) {
      const pending = [...this.#authoringContinuationPending]
        .filter(([continuationId]) => continuationId.startsWith(continuationPrefix))
        .map(([, continuation]) => continuation)
      await Promise.all(pending)
      await agent.whenIdle()
      await Promise.resolve()
      const hasPending = [...this.#authoringContinuationPending.keys()].some((continuationId) =>
        continuationId.startsWith(continuationPrefix),
      )
      if (!hasPending && agent.status !== 'running') return
    }
    throw new Error('智能体扩展开发收尾没有静止，暂时不能保存候选。')
  }

  defineDynamicPackage(dshSessionId: string, input: DynamicPackageDefinitionInput): DynamicCordisDefineReceipt {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.define({
      sessionId: agent.id,
      plugin:
        input.plugin.kind === 'new'
          ? { kind: 'new', idPrefix: input.plugin.idPrefix }
          : { kind: 'existing', pluginId: CordisDynamicPluginId(input.plugin.pluginId) },
      name: input.name,
      purpose: input.purpose,
      code: input.code,
    })
  }

  defineDynamicAuthoringPackage(
    dshSessionId: string,
    input: DynamicAuthoringPackageDefinitionInput,
  ): DynamicCordisDefineReceipt {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.defineAuthoringPackage(agent.id, input)
  }

  runDynamicPackage(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
    mode: CordisDynamicRunMode,
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponse> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner
      .run(agent, CordisDynamicPluginId(pluginId), CordisDynamicPackageId(packageId), mode, signal)
      .then(async (result) => {
        if (result.ok && result.waitingFor.some((service) => EXTENSION_PRIVATE_SERVICE_KEY_SET.has(service))) {
          await runner.stop(agent, CordisDynamicPluginId(pluginId))
          const message = `Dynamic Extension requested a private Host Service: ${result.waitingFor.join(', ')}`
          return {
            ok: false,
            reason: 'host-half-failed',
            message,
          }
        }
        return result
      })
  }

  stopDynamicPlugin(dshSessionId: string, pluginId: string): Promise<DynamicCordisStopResponse> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.stop(agent, CordisDynamicPluginId(pluginId))
  }

  undefineDynamicPlugin(dshSessionId: string, pluginId: string): Promise<DynamicCordisUndefineReceipt> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.undefine(agent, CordisDynamicPluginId(pluginId))
  }

  inspectDynamicPackage(dshSessionId: string, pluginId: string, packageId: string): DynamicCordisPackageInspection {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.inspectPackage(agent, CordisDynamicPluginId(pluginId), CordisDynamicPackageId(packageId))
  }

  dynamicAuthoringSnapshot(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
  ): Promise<DynamicAuthoringSnapshot | undefined> {
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (!this.#authoring || !episodeId) return Promise.resolve(undefined)
    return this.#authoring.service.snapshotForRunnerPackage(episodeId, pluginId, packageId)
  }

  decideAuthoringAttempt(input: Parameters<DynamicAuthoringService['decideAttempt']>[0]) {
    this.#assertActive()
    if (!this.#authoring) throw new Error('动态创造账本未启用。')
    return this.#authoring.service.decideAttempt(input)
  }

  stopAuthoringTask(input: Parameters<DynamicAuthoringService['stopTask']>[0]) {
    this.#assertActive()
    if (!this.#authoring) throw new Error('动态创造账本未启用。')
    return this.#authoring.service.stopTask(input, async (task) => {
      const session = [...this.#sessions.records()].find((record) => record.episodeId === task.episodeId)
      if (!session) return
      const result = await this.stopDynamicPlugin(session.sessionId, task.pluginKey)
      if (!result.ok && result.reason !== 'plugin-missing' && result.reason !== 'not-running') {
        throw new Error('动态扩展未能停止。')
      }
    })
  }

  async deleteAuthoringTask(taskId: AuthoringTaskId): Promise<boolean> {
    this.#assertActive()
    if (!this.#authoring) throw new Error('动态创造账本未启用。')
    const task = this.#authoring.service.getTask(taskId)
    if (!task) return false
    const dshSessionId = [...this.#sessions.records()].find((record) => record.episodeId === task.episodeId)?.sessionId
    if (dshSessionId !== undefined) {
      const stopped = await this.stopDynamicPlugin(dshSessionId, task.pluginKey)
      if (!stopped.ok && stopped.reason !== 'plugin-missing' && stopped.reason !== 'not-running') {
        throw new Error(stopped.message)
      }
      const stoppedRow = this.dynamicInventory(dshSessionId).find((row) => row.pluginId === task.pluginKey)
      if (stoppedRow?.latestRun) {
        this.syncAuthoringRow(task.episodeId, stoppedRow, stoppedRow.latestRun.packageId)
      }
      const undefinedPlugin = await this.undefineDynamicPlugin(dshSessionId, task.pluginKey)
      if (!undefinedPlugin.ok && undefinedPlugin.reason !== 'plugin-missing') {
        throw new Error(undefinedPlugin.message)
      }
    }
    const settledTask = this.#authoring.service.getTask(taskId)
    if (settledTask && !['interrupted', 'stopped', 'completed'].includes(settledTask.status)) {
      this.#authoring.service.interruptTask(settledTask, '删除前未找到可继续运行的临时 Plugin。')
    }
    return this.#authoring.service.deleteTask(taskId)
  }

  async verifyDynamicPackage(dshSessionId: string, pluginId: string, packageId: string) {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const evidence = runner.verificationSnapshot(agent, pluginId, packageId)
    const visibleTools = this.#context.tools.schemas(scopeOf(agent.ctx))
    const toolInvocations = [] as Array<{ readonly name: string; readonly succeeded: boolean }>
    const contributions = [] as Array<
      | { readonly kind: 'tool'; readonly name: string; readonly description: string }
      | { readonly kind: 'rpc'; readonly method: string }
      | { readonly kind: 'client-slot'; readonly name: AgentClientSlotName }
      | { readonly kind: 'host-client-slot'; readonly name: AdapterClientSlotName; readonly key: string }
      | HostPageContribution
      | {
          readonly kind: 'adapter'
          readonly apiVersion: 2
          readonly key: string
          readonly descriptorDigest: string
        }
    >
    if (runner.isAdapterPackage(packageId)) {
      if (evidence.toolNames.length > 0 || evidence.renderedSlots.length > 0) {
        throw new Error('适配器 Revision 不能混装智能体工具或智能体 Slot，请拆分为两个扩展。')
      }
      const foreignRpc = evidence.rpcMethods.filter((method) => method !== ADAPTER_DYNAMIC_EVIDENCE_METHOD)
      if (foreignRpc.length > 0) throw new Error('适配器 Revision 不能混装智能体 RPC，请拆分为两个扩展。')
      const result = await runner.invoke(
        CordisDynamicPluginId(pluginId),
        CordisDynamicPluginRunId(evidence.pluginRunId),
        ADAPTER_DYNAMIC_EVIDENCE_METHOD,
        null,
      )
      if (!result.ok) throw new Error(`Adapter synthetic verification failed: ${result.message}`)
      const observed = AdapterDynamicEvidenceSchema.parse(result.value)
      if (
        !observed.started ||
        !observed.stopped ||
        !observed.credentialIsolated ||
        !observed.inboundCommitted ||
        !observed.channelDiscovered ||
        observed.outboundReceipt !== 'sent' ||
        !observed.transportIdle
      ) {
        throw new Error('适配器验证未完整通过创建、入站、出站、凭据隔离和停止静止检查。')
      }
      const descriptorDigest = createHash('sha256')
        .update(canonicalJson(JsonValueSchema.parse(observed.descriptor)))
        .digest('hex')
      const adapter = {
        apiVersion: 2 as const,
        key: observed.descriptor.key,
        descriptorDigest,
        registered: true,
        started: observed.started,
        stopped: observed.stopped,
        inboundCommitted: observed.inboundCommitted,
        outboundReceipt: observed.outboundReceipt,
      }
      const renderedHostSlots = evidence.renderedHostSlots.filter((slot) =>
        slot.name === 'conversation.message.rich'
          ? slot.key.startsWith(`${adapter.key}:`) && slot.key.length > adapter.key.length + 1
          : slot.key === adapter.key,
      )
      if (renderedHostSlots.length !== evidence.renderedHostSlots.length) {
        throw new Error(`适配器 Client Slot 没有使用 ${adapter.key} 的稳定 key。`)
      }
      for (const slot of renderedHostSlots) {
        contributions.push({ kind: 'host-client-slot', name: slot.name, key: slot.key })
      }
      contributions.push(...evidence.renderedPages)
      contributions.push({ kind: 'adapter', apiVersion: 2, key: adapter.key, descriptorDigest })
      return {
        ...evidence,
        renderedHostSlots,
        rpcMethods: [],
        renderedSlots: [],
        contributions,
        toolInvocations,
        scope: 'host-adapter' as const,
        adapter,
      }
    }
    if (evidence.renderedPages.length > 0) {
      if (evidence.toolNames.length > 0 || evidence.renderedSlots.length > 0 || evidence.renderedHostSlots.length > 0) {
        throw new Error('页面 Extension 不能混装智能体工具、智能体 Slot 或 Adapter Slot，请拆分为两个扩展。')
      }
      for (const method of evidence.rpcMethods) {
        const result = await runner.invoke(
          CordisDynamicPluginId(pluginId),
          CordisDynamicPluginRunId(evidence.pluginRunId),
          method,
          null,
        )
        if (!result.ok) throw new Error(`Dynamic RPC synthetic verification failed: ${method}: ${result.message}`)
        if (JSON.stringify(result.value).length > 16 * 1024) {
          throw new Error(`Dynamic RPC verification exceeded 16 KiB: ${method}`)
        }
      }
      return {
        ...evidence,
        contributions: evidence.renderedPages,
        toolInvocations,
        scope: 'host-ui' as const,
      }
    }
    if (evidence.renderedHostSlots.length > 0) {
      throw new Error('智能体 Extension 不能注册 Host Adapter rich Slot，请拆分为两个扩展。')
    }
    for (const name of evidence.toolNames) {
      const schema = visibleTools.find((candidate) => candidate.name === name)
      if (!schema) throw new Error(`Dynamic Tool disappeared before verification: ${name}`)
      const result = await this.#context.tools.execute({
        callId: CallId(`verify-${packageId}-${name}`),
        name,
        arguments: {},
        agent,
        signal: new AbortController().signal,
      })
      if (result.isError)
        throw new Error(`Dynamic Tool synthetic verification failed: ${name}: ${result.error.message}`)
      if (JSON.stringify(result.value).length > 16 * 1024)
        throw new Error(`Dynamic Tool verification exceeded 16 KiB: ${name}`)
      toolInvocations.push({ name, succeeded: true })
      contributions.push({ kind: 'tool', name, description: schema.description })
    }
    for (const method of evidence.rpcMethods) {
      const result = await runner.invoke(
        CordisDynamicPluginId(pluginId),
        CordisDynamicPluginRunId(evidence.pluginRunId),
        method,
        null,
      )
      if (!result.ok) throw new Error(`Dynamic RPC synthetic verification failed: ${method}: ${result.message}`)
      if (JSON.stringify(result.value).length > 16 * 1024)
        throw new Error(`Dynamic RPC verification exceeded 16 KiB: ${method}`)
      contributions.push({ kind: 'rpc', method })
    }
    for (const name of evidence.renderedSlots) contributions.push({ kind: 'client-slot', name })
    return { ...evidence, contributions, toolInvocations }
  }

  async completeAuthoringVerification(dshSessionId: string, pluginId: string, packageId: string): Promise<void> {
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (!this.#authoring || !episodeId) return
    const verified = await this.verifyDynamicPackage(dshSessionId, pluginId, packageId)
    const snapshot = await this.dynamicAuthoringSnapshot(dshSessionId, pluginId, packageId)
    const row = this.dynamicInventory(dshSessionId).find((candidate) => candidate.pluginId === pluginId)
    const latest = row?.latestRun
    if (!latest || latest.packageId !== packageId || latest.status !== 'running') {
      throw new Error('动态扩展验证完成时，候选已经不再是当前运行版本。')
    }
    this.#authoring.service.syncAttempt({
      episodeId,
      pluginKey: pluginId,
      runnerPackageId: packageId,
      runnerRunId: verified.pluginRunId,
      state: 'active',
      taskStatus: 'ready',
      host: {
        status: latest.host.status,
        waitingFor: latest.host.waitingFor,
        ...(latest.host.error === undefined ? {} : { error: latest.host.error }),
      },
      client: {
        status: latest.client.status,
        waitingFor: latest.client.waitingFor,
        ...(latest.client.error === undefined ? {} : { error: latest.client.error }),
      },
      verification: {
        hostStarted: latest.host.status === 'running' || latest.host.status === 'absent',
        clientLoaded: latest.client.status === 'running' || latest.client.status === 'absent',
        renderedSlots: verified.renderedSlots,
        renderedPages: verified.renderedPages,
        usedUiComponents: verified.usedUiComponents,
        pageGeometry: verified.pageGeometry,
        rpcCalls: verified.rpcMethods,
        toolInvocations: verified.toolInvocations,
        navigationChecks: verified.navigationEntries,
        resourceChecks: Object.keys(snapshot?.resources ?? {}).sort(),
        stoppedCleanly: false,
      },
      eventKind: 'verification-completed',
      eventPayload: {
        renderedSlots: [...verified.renderedSlots],
        renderedPages: verified.renderedPages.map((page) => page.entryId),
        toolInvocations: verified.toolInvocations.map(({ name }) => name),
      },
    })
  }

  dynamicInventory(dshSessionId: string): readonly DynamicCordisInventoryRow[] {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.inventory().filter(({ agentId }) => agentId === agent.id)
  }

  syncAuthoringRow(episodeId: EpisodeId, row: DynamicCordisInventoryRow, packageId: string): void {
    const latest = row.latestRun
    if (!this.#authoring || !latest || latest.packageId !== packageId) return
    const state =
      latest.status === 'awaiting-approval'
        ? 'awaiting-approval'
        : latest.status === 'starting-host'
          ? 'starting-host'
          : latest.status === 'client-pending'
            ? 'loading-client'
            : latest.status === 'running' || latest.status === 'waiting'
              ? 'active'
              : latest.status === 'rejected'
                ? 'rejected'
                : latest.status === 'stopped'
                  ? 'stopped'
                  : 'failed'
    const taskStatus =
      latest.status === 'awaiting-approval'
        ? 'awaiting-approval'
        : latest.status === 'failed' || latest.status === 'cancelled'
          ? 'failed'
          : latest.status === 'rejected'
            ? 'working'
            : latest.status === 'stopped'
              ? 'stopped'
              : 'running'
    const eventKind =
      latest.status === 'awaiting-approval'
        ? 'approval-requested'
        : latest.status === 'failed' || latest.status === 'cancelled'
          ? 'attempt-failed'
          : latest.status === 'rejected'
            ? 'approval-rejected'
            : latest.status === 'stopped'
              ? 'task-stopped'
              : 'phase-changed'
    this.#authoring.service.syncAttempt({
      episodeId,
      pluginKey: row.pluginId,
      runnerPackageId: latest.packageId,
      runnerRunId: latest.pluginRunId,
      state,
      taskStatus,
      host: {
        status: latest.host.status,
        waitingFor: latest.host.waitingFor,
        ...(latest.host.error === undefined ? {} : { error: latest.host.error }),
      },
      client: {
        status: latest.client.status,
        waitingFor: latest.client.waitingFor,
        ...(latest.client.error === undefined ? {} : { error: latest.client.error }),
      },
      ...(latest.error === undefined
        ? {}
        : {
            error: {
              phase: latest.error.phase,
              message: latest.error.message,
              ...(latest.error.stack === undefined ? {} : { stack: latest.error.stack }),
              repairable: latest.error.phase !== 'approval',
            },
          }),
      eventKind,
      eventPayload: { status: latest.status },
    })
  }

  queueAuthoringContinuation(episodeId: EpisodeId, row: DynamicCordisInventoryRow): void {
    const latest = row.latestRun
    if (!this.#authoring || !latest || !['running', 'failed', 'cancelled'].includes(latest.status)) {
      return
    }
    const task = this.#authoring.service.taskForRunner(episodeId, row.pluginId)
    const dshSessionId = [...this.#sessions.records()].find((record) => record.episodeId === episodeId)?.sessionId
    const agent = dshSessionId === undefined ? undefined : this.#context.agents.get(SessionId(dshSessionId))
    if (!task || !agent) return
    const messageId = createHash('sha256')
      .update(`${task.id}:${latest.packageId}:${latest.pluginRunId ?? 'pending'}:${latest.status}`)
      .digest('hex')
      .slice(0, 24)
    const continuationId = `${agent.id}:${messageId}`
    if (this.#authoringContinuationIds.has(continuationId)) return
    this.#authoringContinuationIds.add(continuationId)
    const content = [
      '这是 NekroNXT Host 产生的扩展开发状态事件，不是用户的新需求。',
      `任务：${task.title}（${task.id}）`,
      `候选：${latest.packageId}；状态：${latest.status}。`,
      latest.error === undefined
        ? '运行链路已经返回结果。请核对真实预览和验证证据；成功时向用户清楚说明可见成果，失败时继续修复同一 Plugin。'
        : `失败阶段：${latest.error.phase}；错误：${latest.error.message}。请读取当前诊断，向同一 Plugin 追加修复候选并继续验证。`,
      '不需要等待用户再发送“继续”，也不要把定义、审批或 Host 启动误报为最终成功。',
    ].join('\n')
    const pending = (async () => {
      try {
        await agent.whenIdle()
        if (this.#context.agents.get(agent.id) !== agent) {
          this.#authoringContinuationIds.delete(continuationId)
          return
        }
        agent.inject(
          freezeMessage({
            id: MessageId(`nxt-authoring-${messageId}`),
            role: 'user',
            content: [{ type: 'text', text: content }],
            source: {
              kind: 'nekro-nxt-authoring-event',
              taskId: task.id,
              pluginId: row.pluginId,
              packageId: latest.packageId,
              status: latest.status,
            },
          }),
        )
        await this.#context.sessions.flush(agent.session)
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes(`message "nxt-authoring-${messageId}" is already pending`)
        ) {
          return
        }
        this.#authoringContinuationIds.delete(continuationId)
        console.error('[nekro-nxt] 扩展开发自动续跑事件注入失败：', error)
      } finally {
        this.#authoringContinuationPending.delete(continuationId)
      }
    })()
    this.#authoringContinuationPending.set(continuationId, pending)
  }

  subscribeDynamicApprovalRequests(listener: (event: DynamicApprovalRequestEvent) => void): () => void {
    this.#assertActive()
    this.#dynamicApprovalListeners.add(listener)
    return () => this.#dynamicApprovalListeners.delete(listener)
  }

  subscribeAuthoringChanges(
    listener: (change: { readonly taskId: AuthoringTaskId; readonly agentId: AgentId }) => void,
  ): () => void {
    this.#assertActive()
    return this.#authoring?.service.subscribe(listener) ?? (() => undefined)
  }

  dynamicAuthoringPolicy(dshSessionId: string): DynamicAuthoringPolicyState {
    return this.dynamicRuntime(dshSessionId).runner.policySnapshot()
  }

  async runDynamicHostHalf(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
    mode: CordisDynamicRunMode,
    requestId: string | null,
    approveFutureVersions: boolean,
  ): Promise<DynamicCordisHostHalfResult> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const result = await runner.runHostHalf(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPackageId(packageId),
      mode,
      requestId === null ? null : ApprovalRequestId(requestId),
      approveFutureVersions,
    )
    const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (row && episodeId) this.syncAuthoringRow(episodeId, row, packageId)
    return result
  }

  getDynamicClientCode(dshSessionId: string, pluginId: string, pluginRunId: string): DynamicCordisClientSource {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    return runner.getClientCode(agent, CordisDynamicPluginId(pluginId), CordisDynamicPluginRunId(pluginRunId))
  }

  async resolveDynamicRunRequest(
    dshSessionId: string,
    requestId: string,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisResolveAck> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const owned = runner
      .inventory()
      .find((row) => row.agentId === agent.id && row.latestRun?.approvalRequestId === ApprovalRequestId(requestId))
    if (!owned?.latestRun) throw new Error('Dynamic Client approval request is not owned by this DSH Session.')
    const result = await runner.resolveRequestRun(ApprovalRequestId(requestId), resolution)
    const row = runner.inventory().find((candidate) => candidate.pluginId === owned.pluginId)
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (row && episodeId) this.syncAuthoringRow(episodeId, row, owned.latestRun.packageId)
    return result
  }

  async settleDynamicUserRun(
    dshSessionId: string,
    pluginId: string,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisRunResponse> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const result = await runner.settleUserRun(agent, CordisDynamicPluginId(pluginId), resolution)
    const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (row?.latestRun && episodeId) {
      this.syncAuthoringRow(episodeId, row, row.latestRun.packageId)
      this.queueAuthoringContinuation(episodeId, row)
    }
    return result
  }

  invokeDynamicHost(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    method: string,
    input: JsonValue = null,
  ): Promise<DynamicCordisInvokeResult> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const owned = runner.inventory().some((row) => row.agentId === agent.id && row.pluginId === pluginId)
    if (!owned) throw new Error('Dynamic Extension is not owned by this DSH Session.')
    return runner
      .invoke(CordisDynamicPluginId(pluginId), CordisDynamicPluginRunId(pluginRunId), method, input)
      .then((result) => {
        if (result.ok) runner.recordClientRpcInvocation(agent, pluginId, pluginRunId, method)
        return result
      })
  }

  async reportDynamicRenderFailure(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    failure: DynamicCordisRenderFailure,
  ): Promise<null> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const result = await runner.reportRenderFailure(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPluginRunId(pluginRunId),
      failure,
    )
    const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (row?.latestRun && episodeId) {
      this.syncAuthoringRow(episodeId, row, row.latestRun.packageId)
      this.queueAuthoringContinuation(episodeId, row)
    }
    return result
  }

  async recordDynamicClientVerification(
    dshSessionId: string,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    renderedSlots: readonly AgentClientSlotName[],
    renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[] = [],
    renderedPages: readonly HostPageContribution[] = [],
    usedUiComponents: readonly HostUiKitComponentName[] = [],
    pageGeometry: readonly HostUiPageGeometryEvidence[] = [],
    permissions: HostUiPermissionDeclaration = { permissions: [], networkOrigins: [] },
    navigationEntries: readonly string[] = [],
  ): Promise<void> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    try {
      const declared = await this.dynamicAuthoringSnapshot(dshSessionId, pluginId, packageId)
      if (declared) {
        const declaredPages = declared.contributions.map((contribution) =>
          HostPageContributionSchema.parse(contribution),
        )
        if (JSON.stringify(declaredPages) !== JSON.stringify(renderedPages)) {
          throw new Error('动态 Client 实际注册的页面与候选声明不一致。')
        }
        if (JSON.stringify(declared.permissions) !== JSON.stringify(permissions)) {
          throw new Error('动态 Client 实际声明的权限与候选风险摘要不一致。')
        }
      }
      const navigationEntrySet = new Set(navigationEntries)
      for (const page of renderedPages) {
        if (page.objectPane === 'navigation' && !navigationEntrySet.has(page.entryId)) {
          throw new Error(`动态页面 ${page.entryId} 声明对象列，但没有注册 Navigation Provider。`)
        }
        if (page.objectPane === 'hidden' && navigationEntrySet.has(page.entryId)) {
          throw new Error(`动态页面 ${page.entryId} 隐藏对象列，不能注册 Navigation Provider。`)
        }
      }
      if (navigationEntries.some((entryId) => !renderedPages.some((page) => page.entryId === entryId))) {
        throw new Error('动态 Client 上报了不属于当前页面声明的 Navigation Provider。')
      }
      runner.recordClientVerification(
        agent,
        pluginId,
        packageId,
        pluginRunId,
        renderedSlots,
        renderedHostSlots,
        renderedPages,
        usedUiComponents,
        pageGeometry,
        navigationEntries,
        permissions,
      )
      const episodeId = this.#sessions.get(dshSessionId)?.episodeId
      await this.completeAuthoringVerification(dshSessionId, pluginId, packageId)
      const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
      if (row && episodeId) {
        this.queueAuthoringContinuation(episodeId, row)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await runner.reportClientGuardFailure(
        agent,
        CordisDynamicPluginId(pluginId),
        CordisDynamicPluginRunId(pluginRunId),
        {
          message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      )
      const episodeId = this.#sessions.get(dshSessionId)?.episodeId
      const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
      if (row?.latestRun && episodeId) {
        this.syncAuthoringRow(episodeId, row, row.latestRun.packageId)
        this.queueAuthoringContinuation(episodeId, row)
      }
      throw error
    }
  }

  async reportDynamicGuardFailure(
    dshSessionId: string,
    pluginId: string,
    pluginRunId: string,
    failure: CordisErrorDetails,
  ): Promise<null> {
    const { agent, runner } = this.dynamicRuntime(dshSessionId)
    const result = await runner.reportClientGuardFailure(
      agent,
      CordisDynamicPluginId(pluginId),
      CordisDynamicPluginRunId(pluginRunId),
      failure,
    )
    const row = runner.inventory().find((candidate) => candidate.pluginId === pluginId)
    const episodeId = this.#sessions.get(dshSessionId)?.episodeId
    if (row?.latestRun && episodeId) {
      this.syncAuthoringRow(episodeId, row, row.latestRun.packageId)
      this.queueAuthoringContinuation(episodeId, row)
    }
    return result
  }

  dynamicToolNames(dshSessionId: string): readonly string[] {
    this.dynamicRuntime(dshSessionId)
    return this.toolNames(dshSessionId)
  }

  toolNames(dshSessionId: string): readonly string[] {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    return this.#context.tools.schemas(scopeOf(agent.ctx)).map(({ name }) => name)
  }

  queryNekroNxtInspect(
    dshSessionId: string,
    method: 'currentContext' | 'supportedContributions' | 'developmentExample' | 'extensionLifecycle',
  ): Promise<JsonValue> {
    const { agent, context } = this.dynamicRuntime(dshSessionId)
    const registry = context.get('cordisInspect')
    if (!registry) throw new Error('Cordis Inspect registry is unavailable in this DSH Session.')
    return registry.query('host', 'nekro-nxt-runtime', method, {}, agent, new AbortController().signal)
  }

  async loadNekroNxtExtensionSkill(dshSessionId: string): Promise<{
    readonly provider: string
    readonly content: string
  }> {
    const { agent } = this.dynamicRuntime(dshSessionId)
    const skill = await this.#context.skills.get('cordis-plugin-development', { scope: agent })
    if (!skill) throw new Error('NekroNxt extension development skill is unavailable in this DSH Session.')
    return { provider: skill.provider, content: skill.content }
  }

  async waitUntilSafe(agentId: AgentRevisionRecord['agentId']): Promise<void> {
    this.#assertActive()
    const handles = [...this.#sessions.handles()].filter(
      ([sessionId]) => this.#sessions.get(sessionId)?.revision.agentId === agentId,
    )
    await Promise.all(handles.map(([, handle]) => handle.agent.whenIdle()))
    const sessionIds = new Set(handles.map(([sessionId]) => sessionId))
    await Promise.all(
      [...this.#authoringContinuationPending.entries()]
        .filter(([continuationId]) => sessionIds.has(continuationId.slice(0, continuationId.indexOf(':'))))
        .map(([, continuation]) => continuation),
    )
    await Promise.all(handles.map(([, handle]) => handle.agent.whenIdle()))
  }

  dynamicRuntime(dshSessionId: string): {
    readonly agent: Agent
    readonly context: Context
    readonly runner: NekroNxtDynamicCordisRunner
  } {
    this.#assertActive()
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    const owned = this.#sessions.get(dshSessionId)?.dynamic
    if (!owned) {
      throw new Error('Dynamic creation is not granted to this Agent Revision.')
    }
    return { agent, ...owned }
  }

  resolveDynamicAuthoringOwner(input: {
    readonly caller: Agent
    readonly rootSessionId: SessionId
    readonly runner: NekroNxtDynamicCordisRunner
    readonly revision: AgentRevisionRecord
    readonly channelId: ChannelId
    readonly episodeId: EpisodeId
  }): Agent {
    const { caller, rootSessionId, runner, revision, channelId, episodeId } = input
    if (this.#context.agents.get(caller.id) !== caller) {
      throw new Error('Dynamic authoring caller Agent is stale or offline.')
    }
    const header = caller.session.header
    if (header.origin !== 'subagent' || header.delegationDepth !== 1 || header.parentSession !== rootSessionId) {
      throw new Error('Dynamic authoring is only available to a direct child of the owning root Session.')
    }
    const owner = this.#context.agents.get(rootSessionId)
    if (!owner || this.#sessions.get(rootSessionId)?.handle?.agent !== owner) {
      throw new Error('Dynamic authoring root Session is stale or offline.')
    }
    if (this.#sessions.get(rootSessionId)?.dynamic?.runner !== runner) {
      throw new Error('Dynamic authoring Runner is not owned by the expected root Session.')
    }
    const mappedRevision = this.#sessions.get(rootSessionId)?.revision
    if (
      this.#sessions.get(rootSessionId)?.revision.agentId !== revision.agentId ||
      this.#sessions.get(rootSessionId)?.channelId !== channelId ||
      this.#sessions.get(rootSessionId)?.episodeId !== episodeId ||
      mappedRevision?.id !== revision.id ||
      mappedRevision.agentId !== revision.agentId ||
      mappedRevision.capabilities.dynamicCreation !== true
    ) {
      throw new Error('Dynamic authoring root Session ownership no longer matches its immutable Revision.')
    }
    return owner
  }
}
