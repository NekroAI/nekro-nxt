import { ExtensionLibrary, memoryLibraryRegistry } from './extension-library.js'
import { memoryIndexEngine } from './extension-index.js'
import { AdapterRegistry, type AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import {
  configFields,
  EXTENSION_DATA_HOOK_PERMISSIONS,
  ExtensionPanelDeclarationSchema,
  HOST_UI_KIT_COMPONENT_NAMES,
  HostPageContributionSchema,
  HostUiNavigationModelSchema,
  JsonValueSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
  validateConfigValue,
  hostLayerAsCapabilities,
  type ExtensionCapabilities,
  type ExtensionDataHookName,
  type ExtensionPermissions,
  type HostPageContribution,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'
import {
  hasAgentLayer,
  layerConfigSchema,
  manifestAdapter,
  type ImportedRevisionVerificationInput,
  type ImportedRevisionVerifier,
} from '@nekro-nxt/extension-runtime'
import type {
  ExtensionRpcHandler,
  ExtensionToolDefinition,
  NxtCallContext,
  NxtInboundHandler,
  NxtJobHandler,
  NxtInboundMessage,
} from '@nekro-nxt/extension-sdk'
import { createFakeAdapterHostContext } from '@nekro-nxt/test-harness'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createExtensionEgress } from './extension-egress.js'
import { memoryNxtJobs, memoryNxtStorage, previewPlatformResult } from './extension-host-backends.js'
import { createHostLayerNxt, createNxtHostService, type NxtServiceBackends } from './extension-host-service.js'

const IMPORT_ORIGIN = {
  episodeId: 'import',
  pluginId: 'import',
  packageId: 'import',
  pluginRunId: 'local-runtime-verification',
} as const

const recordOf = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象。`)
  return Object.fromEntries(Object.entries(value))
}

const callableOf = (
  value: unknown,
  label: string,
): ((thisArgument: unknown, argumentsList: readonly unknown[]) => unknown) => {
  if (typeof value !== 'function') throw new Error(`${label} 必须是函数。`)
  return (thisArgument, argumentsList) => {
    const result: unknown = Reflect.apply(value, thisArgument, argumentsList)
    return result
  }
}

const errorOf = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

const importFactory = async (entry: string, buildKey: string, label: string) => {
  const loaded: unknown = await import(`${pathToFileURL(entry).href}?import-verify=${buildKey}`)
  return callableOf(recordOf(loaded, `${label}模块`)['default'], `${label}默认导出`)
}

const descriptorDigest = (contribution: AdapterHostContributionV2): string =>
  createHash('sha256')
    .update(canonicalJson(JsonValueSchema.parse(JSON.parse(JSON.stringify(contribution.descriptor)))))
    .digest('hex')

const simpleElement = (type: unknown, props?: object | null, ...children: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children },
})

const component = (props: { readonly children?: unknown }) => simpleElement('div', null, props.children)
const compoundComponent = new Proxy(
  {},
  {
    get: () => component,
  },
)

const createClientHarness = () => {
  const effectCleanups: Array<() => void | Promise<void>> = []
  const subscriptions: Array<() => void> = []
  const React = {
    createElement: simpleElement,
    Fragment: 'fragment',
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      let value: unknown = initial
      if (typeof initial === 'function') {
        const resolved: unknown = Reflect.apply(initial, undefined, [])
        value = resolved
      }
      return [
        value,
        (next: unknown) => {
          if (typeof next === 'function') {
            const resolved: unknown = Reflect.apply(next, undefined, [value])
            value = resolved
          } else {
            value = next
          }
        },
      ]
    },
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    useMemo: <Value>(factory: () => Value) => factory(),
    useCallback: <Value extends (...args: never[]) => unknown>(callback: Value) => callback,
    useRef: <Value>(initial: Value) => ({ current: initial }),
    useSyncExternalStore: <Snapshot>(subscribe: (listener: () => void) => () => void, getSnapshot: () => Snapshot) => {
      subscriptions.push(subscribe(() => undefined))
      return getSnapshot()
    },
  }
  const ui = {
    version: 'ui-kit@2',
    ...Object.fromEntries(HOST_UI_KIT_COMPONENT_NAMES.map((name) => [name, compoundComponent])),
  }
  return {
    React,
    ui,
    dispose: async () => {
      for (const cleanup of [...effectCleanups].reverse()) await cleanup()
      for (const unsubscribe of [...subscriptions].reverse()) unsubscribe()
    },
  }
}

const SYNTHETIC_ANCHOR_IDS = {
  agent: 'agt_IMPORT',
  channel: 'chn_IMPORT',
  extension: 'ext_IMPORT',
  connection: 'con_IMPORT',
} as const

const syntheticToolCall = (toolName: string) => ({
  callId: 'call_IMPORT',
  toolName,
  state: 'succeeded' as const,
  input: '{}',
  result: '{"ok":true}',
  durationMs: 12,
})

/** Synthetic read model for verification; hooks throw unless the Manifest declared their permission. */
const syntheticData = (granted: ReadonlySet<string>) => {
  const guard = <Value>(hook: ExtensionDataHookName, value: Value) => {
    const permission = EXTENSION_DATA_HOOK_PERMISSIONS[hook]
    if (!granted.has(permission)) throw new Error(`Client 调用 ${hook} 需要在 Manifest 声明权限 ${permission}。`)
    return value
  }
  return {
    useAgent: (id: string) => guard('useAgent', { id, name: '导入验证智能体', phase: 'idle' }),
    useChannel: (id: string) =>
      guard('useChannel', {
        id,
        name: '导入验证频道',
        kind: 'group',
        connectionId: 'con_IMPORT',
        agentId: 'agt_IMPORT',
      }),
    useConnection: (id: string) =>
      guard('useConnection', { id, name: '导入验证连接', adapterKey: 'import', state: 'connected' }),
    useChannelRuntime: (channelId: string) => guard('useChannelRuntime', { channelId, phase: 'idle' }),
  }
}

const runPluginApply = async (
  definition: unknown,
  context: unknown,
): Promise<(() => void | Promise<void>) | undefined> => {
  const plugin = recordOf(definition, 'Extension factory 结果')
  const apply = callableOf(plugin['apply'], 'Extension factory apply')
  const dispose = await apply(definition, [context])
  if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Extension apply 返回了无效 disposer。')
  if (dispose === undefined) return undefined
  const invokeDispose = callableOf(dispose, 'Extension disposer')
  return async () => {
    await Promise.resolve(invokeDispose(definition, []))
  }
}

/** Runs one registered adapter through a fake Host: start, an inbound fact, one delivery and a quiet stop. */
const verifyAdapterContribution = async (
  contribution: AdapterHostContributionV2,
  declared: { readonly key: string; readonly descriptorDigest: string },
) => {
  const digest = descriptorDigest(contribution)
  if (contribution.descriptor.key !== declared.key || digest !== declared.descriptorDigest) {
    throw new Error('适配器实际注册内容与扩展清单不一致。')
  }
  const fake = createFakeAdapterHostContext()
  const configuration: Record<string, string | number | boolean> = {}
  const credentialRefs: Record<string, string> = {}
  for (const field of configFields(contribution.descriptor.configSchema)) {
    if (field.kind === 'secret') {
      const reference = `import-credential:${field.key}`
      credentialRefs[field.key] = reference
      fake.credentials.set(reference, 'synthetic-import-secret')
    } else if (
      typeof field.default === 'string' ||
      typeof field.default === 'number' ||
      typeof field.default === 'boolean'
    )
      configuration[field.key] = field.default
    else if (field.kind === 'enum' && field.options?.[0] !== undefined) {
      const value = field.options[0].value
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        configuration[field.key] = value
    } else if (field.kind === 'string') configuration[field.key] = 'https://adapter.example.test'
    else if (field.kind === 'number') configuration[field.key] = 1
    else if (field.kind === 'boolean') configuration[field.key] = false
  }
  const runtime = await contribution.create(fake.context, { configuration, credentialRefs })
  let started = false
  let stopped = false
  let receipt: 'sent' | 'failed' | 'unknown' = 'failed'
  let lifecycleError: unknown
  try {
    await runtime.start()
    started = true
    const channelId = await fake.context.channels.ensure({
      platformChannelId: 'import-verification',
      kind: 'group',
      observedAt: fake.context.now(),
    })
    const outcome = await runtime.deliver(
      {
        deliveryId: PhysicalDeliveryIdSchema.parse('phy_IMPORTVERIFY'),
        connectionId: fake.context.connectionId,
        channelId,
        logicalMessageId: LogicalMessageIdSchema.parse('msg_IMPORTVERIFY'),
        parts: [{ type: 'text', text: 'import verification' }],
      },
      new AbortController().signal,
    )
    receipt = outcome.status
    if (fake.events.length === 0) throw new Error('适配器本机验证没有提交任何入站事件。')
    if (receipt !== 'sent') throw new Error(`适配器本机验证出站结果不是 sent：${receipt}`)
  } catch (error) {
    lifecycleError = errorOf(error)
  } finally {
    try {
      await runtime.stop()
      stopped = true
      fake.assertIdle()
    } catch (stopError) {
      lifecycleError =
        lifecycleError === undefined
          ? errorOf(stopError)
          : new AggregateError([lifecycleError, errorOf(stopError)], '适配器本机验证失败且未完整静止。')
    }
  }
  if (lifecycleError !== undefined) throw errorOf(lifecycleError)
  return {
    apiVersion: 2 as const,
    key: contribution.descriptor.key,
    descriptorDigest: digest,
    registered: true,
    started,
    stopped,
    inboundCommitted: fake.events.length > 0,
    outboundReceipt: receipt,
  }
}

interface ClientEvidence {
  readonly renderedPanels: readonly string[]
  readonly renderedToolViews: readonly string[]
  readonly renderedMessageRenderers: readonly string[]
  readonly renderedPages: readonly HostPageContribution[]
  readonly permissions: ExtensionPermissions
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((entry) => right.includes(entry))

const verifyClient = async (
  input: ImportedRevisionVerificationInput,
  handlers: ReadonlyMap<string, ExtensionRpcHandler>,
): Promise<ClientEvidence> => {
  const manifest = input.materialized.manifest
  const contributions = manifest.contributions
  const expectedPanels = contributions.flatMap((entry) => (entry.kind === 'panel' ? [entry] : []))
  const expectedToolViews = contributions.flatMap((entry) => (entry.kind === 'tool-view' ? [entry.tool] : []))
  const expectedRenderers = contributions.flatMap((entry) =>
    entry.kind === 'message-renderer' ? [entry.richKind] : [],
  )
  const expectedPages: readonly HostPageContribution[] = contributions.flatMap((entry) =>
    entry.kind === 'host-page' ? [HostPageContributionSchema.parse(entry)] : [],
  )
  const permissions: ExtensionPermissions = manifest.permissions
  if (!input.artifact.clientEntry) {
    if (expectedPanels.length || expectedToolViews.length || expectedRenderers.length || expectedPages.length) {
      throw new Error('Manifest 声明了 Client 贡献，但导入包缺少 Client 构建产物。')
    }
    return { renderedPanels: [], renderedToolViews: [], renderedMessageRenderers: [], renderedPages: [], permissions }
  }

  const harness = createClientHarness()
  const registrations: Array<() => void> = []
  const renderedPanels = new Set<string>()
  const renderedToolViews = new Set<string>()
  const renderedRenderers = new Set<string>()
  const renderedPages: HostPageContribution[] = []
  const subscriptionsCleanup: Array<() => void> = []
  let dispose: (() => void | Promise<void>) | undefined
  const call = async (method: string, value: JsonValue = null): Promise<JsonValue> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`Client 调用了未注册的 Host RPC：${method}`)
    return JsonValueSchema.parse(await handler(value, { surface: 'verification' }))
  }
  const track = (unregister: () => void) => {
    let active = true
    registrations.push(() => {
      active = false
    })
    return () => {
      if (!active) return
      active = false
      unregister()
    }
  }
  let evidence: ClientEvidence | undefined
  let verificationError: unknown
  try {
    const factory = await importFactory(input.artifact.clientEntry, input.artifact.buildKey, 'Extension Client')
    const definition = await factory(undefined, [
      { React: harness.React, styles: {}, host: { call, subscribe: () => () => undefined } },
    ])
    dispose = await runPluginApply(definition, {
      ui: harness.ui,
      data: syntheticData(new Set(permissions.permissions)),
      panels: {
        register: (value: unknown, panelComponent: unknown) => {
          const declaration = ExtensionPanelDeclarationSchema.parse(value)
          const declared = expectedPanels.find(({ id }) => id === declaration.id)
          if (
            !declared ||
            canonicalJson(JsonValueSchema.parse({ ...declaration, kind: 'panel' })) !==
              canonicalJson(JsonValueSchema.parse(declared))
          ) {
            throw new Error(`Client 面板与 Manifest 不一致：${declaration.id}`)
          }
          const render = callableOf(panelComponent, `面板 ${declaration.id} 组件`)
          // Every declared density renders once; the browser verification adds both themes and real geometry.
          for (const density of declared.densities) {
            render(undefined, [
              {
                anchor: { kind: declared.anchor, id: SYNTHETIC_ANCHOR_IDS[declared.anchor] },
                density,
                ...(declared.role === undefined ? {} : { role: declared.role }),
              },
            ])
          }
          renderedPanels.add(declared.id)
          return track(() => undefined)
        },
      },
      toolViews: {
        register: (tool: unknown, viewComponent: unknown) => {
          if (typeof tool !== 'string' || !expectedToolViews.includes(tool)) {
            throw new Error(`Client 注册了未声明的工具视图：${String(tool)}`)
          }
          const render = callableOf(viewComponent, `工具视图 ${tool} 组件`)
          for (const density of ['chip', 'card'] as const)
            render(undefined, [{ call: syntheticToolCall(tool), density }])
          renderedToolViews.add(tool)
          return track(() => undefined)
        },
      },
      messageRenderers: {
        register: (richKind: unknown, rendererComponent: unknown) => {
          if (typeof richKind !== 'string' || !expectedRenderers.includes(richKind)) {
            throw new Error(`Client 注册了未声明的富消息渲染器：${String(richKind)}`)
          }
          const render = callableOf(rendererComponent, `富消息 ${richKind} 渲染器`)
          render(undefined, [
            {
              part: { type: 'rich', adapterKey: 'import', kind: richKind, summary: '导入验证' },
              messageId: 'msg_IMPORT',
              channelId: 'chn_IMPORT',
            },
          ])
          renderedRenderers.add(richKind)
          return track(() => undefined)
        },
      },
      pages: {
        register: (options: unknown, pageComponent: unknown) => {
          const record = recordOf(options, '页面注册参数')
          const page = HostPageContributionSchema.parse(record['page'])
          const declared = expectedPages.find(({ entryId }) => entryId === page.entryId)
          if (
            !declared ||
            canonicalJson(JsonValueSchema.parse(declared)) !== canonicalJson(JsonValueSchema.parse(page))
          ) {
            throw new Error(`Client 页面与 Manifest 不一致：${page.entryId}`)
          }
          const navigation = record['navigation']
          if (navigation !== undefined) {
            const provider = recordOf(navigation, '页面 Navigation Provider')
            const getSnapshot = callableOf(provider['getSnapshot'], 'Navigation getSnapshot')
            HostUiNavigationModelSchema.parse(getSnapshot(navigation, []))
            const subscribe = callableOf(provider['subscribe'], 'Navigation subscribe')
            const unsubscribe = subscribe(navigation, [() => undefined])
            if (typeof unsubscribe !== 'function') throw new Error('Navigation subscribe 必须返回取消函数。')
            subscriptionsCleanup.push(() => void Reflect.apply(unsubscribe, navigation, []))
          }
          const pageFunction = callableOf(pageComponent, `页面 ${page.entryId} 组件`)
          pageFunction(undefined, [
            {
              pageInstanceId: 'hup_IMPORT',
              entryId: page.entryId,
              relativePath: page.startPath,
              search: {},
              navigate: () => undefined,
            },
          ])
          renderedPages.push(page)
          return track(() => undefined)
        },
      },
    })
    const uniquePages = [...new Map(renderedPages.map((page) => [page.entryId, page])).values()]
    if (renderedPanels.size !== expectedPanels.length) throw new Error('Client 未注册 Manifest 声明的全部面板。')
    if (!sameSet([...renderedToolViews], expectedToolViews))
      throw new Error('Client 未注册 Manifest 声明的全部工具视图。')
    if (!sameSet([...renderedRenderers], expectedRenderers))
      throw new Error('Client 未注册 Manifest 声明的全部富消息渲染器。')
    if (uniquePages.length !== expectedPages.length) throw new Error('Client 未注册 Manifest 声明的全部页面。')
    evidence = {
      renderedPanels: [...renderedPanels],
      renderedToolViews: [...renderedToolViews],
      renderedMessageRenderers: [...renderedRenderers],
      renderedPages: uniquePages,
      permissions,
    }
  } catch (error) {
    verificationError = errorOf(error)
  }
  const pendingDispose = dispose
  dispose = undefined
  const cleanup = [
    ...(pendingDispose === undefined ? [] : [pendingDispose]),
    ...registrations.splice(0).reverse(),
    ...subscriptionsCleanup.splice(0).reverse(),
    () => harness.dispose(),
  ]
  const cleanupOutcomes = await Promise.allSettled(cleanup.map((operation) => Promise.resolve().then(operation)))
  const cleanupFailures = cleanupOutcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome): unknown => outcome.reason)
  if (verificationError !== undefined && cleanupFailures.length) {
    throw new AggregateError([verificationError, ...cleanupFailures], 'Extension Client 验证失败，且资源未完整静止。')
  }
  if (verificationError !== undefined) throw errorOf(verificationError)
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Extension Client dispose 失败。')
  if (!evidence) throw new Error('Extension Client 验证没有产生证据。')
  return evidence
}

const VERIFICATION_INBOUND_MESSAGE: NxtInboundMessage = {
  logicalMessageId: 'msg_VERIFY',
  channel: { id: 'chn_VERIFY', kind: 'group', displayName: '验证频道' },
  sender: { memberId: 'mbr_VERIFY', displayName: '验证成员' },
  text: '验证消息',
  mentionsAgent: true,
  wouldTrigger: true,
  receivedAt: 1,
}

const InboundDecisionSchema = z
  .object({
    trigger: z.enum(['default', 'suppress', 'force']).optional(),
    hideFromAgent: z.boolean().optional(),
    annotation: z.string().max(2000).optional(),
  })
  .strict()

const VERIFICATION_CALL_CONTEXT: NxtCallContext = {
  agent: { id: 'agt_VERIFY', name: '验证智能体' },
  channel: { id: 'chn_VERIFY', kind: 'group', displayName: '验证频道' },
  latestInbound: {
    logicalMessageId: 'msg_VERIFY',
    sender: { memberId: 'mbr_VERIFY', displayName: '验证成员' },
    text: '验证消息',
    receivedAt: 1,
  },
}

/**
 * `nxt` backends for save/import verification: throwaway storage, synthetic call context and assets, no saved secrets.
 * Network requests are real, which is why `verificationInput` samples must be side-effect free.
 */
const verificationBackends = (capabilities: ExtensionCapabilities | undefined): NxtServiceBackends => ({
  fetch: (policy, url, init) => createExtensionEgress({ policy }).fetch(url, init),
  storage: memoryNxtStorage(),
  jobs: memoryNxtJobs(),
  platform: {
    catalog: () => {
      const declared = capabilities?.platform
      const adapterKey = declared?.actions[0]?.adapter ?? declared?.raw[0] ?? 'verification'
      return Promise.resolve({
        adapterKey,
        raw: declared?.raw.includes(adapterKey) === true,
        actions: (declared?.actions ?? [])
          .filter(({ adapter }) => adapter === adapterKey)
          .map(({ action }) => ({
            name: action,
            title: action,
            description: '验证动作',
            risk: 'low' as const,
            parameters: {},
          })),
      })
    },
    invoke: (_binding, action) => Promise.resolve(previewPlatformResult('平台动作', action)),
    raw: (_binding, api) => Promise.resolve(previewPlatformResult('原始接口', api)),
    selfPlatformUserId: () => Promise.resolve(undefined),
  },
  members: { describe: (_channelId, memberId) => Promise.resolve({ memberId }) },
  secret: () => Promise.resolve(undefined),
  // Verification never spends the user's model quota; a fixed reply exercises the call path.
  complete: () => Promise.resolve({ text: '验证模型回复' }),
  createAsset: (_channelId, asset) =>
    Promise.resolve({
      assetId: 'ast_VERIFY',
      byteSize: Buffer.byteLength(asset.base64 ?? asset.text ?? '', asset.base64 === undefined ? 'utf8' : 'base64'),
      mediaType: asset.mediaType ?? 'application/octet-stream',
    }),
  callContext: () => Promise.resolve(VERIFICATION_CALL_CONTEXT),
  history: {
    list: () => Promise.resolve({ messages: [] }),
    search: () => Promise.resolve([]),
  },
  // Verification has no real pictures: the library is empty and lookups report a missing Asset.
  library: new ExtensionLibrary({
    registry: memoryLibraryRegistry(),
    assets: { getAssetById: () => undefined, canAccessAsset: () => false, grantAssetAccess: () => undefined },
    assetService: {
      prepare: () => Promise.reject(new Error('验证时不保存文件。')),
      blobPath: () => {
        throw new Error('验证时没有文件。')
      },
    },
    now: () => Date.now(),
  }),
  index: memoryIndexEngine(),
  models: {
    list: () => Promise.resolve([]),
    complete: () => Promise.resolve({ text: '验证模型回复' }),
  },
})

const verificationBinding = {
  agentId: 'agt_VERIFY',
  ownerKey: 'verification',
  displayName: '验证扩展',
  channelId: 'chn_VERIFY',
} as const

/** Declared defaults of one layer stand in for user configuration; required fields without defaults stay absent. */
const defaultConfig = (input: ImportedRevisionVerificationInput, layer: 'host' | 'agent'): JsonValue =>
  validateConfigValue(layerConfigSchema(input.materialized.manifest, layer), {}).value

/**
 * Verifies a Manifest V7 Revision as installed: the Host factory runs once as the host instance (its adapter, RPC and
 * hooks register), the agent attachment applies with a synthetic agent, every Tool and RPC is really called with its
 * verification input, and every Client contribution renders. Nothing here touches product data.
 */
export const verifyImportedExtensionRevision: ImportedRevisionVerifier = async (input) => {
  const manifest = input.materialized.manifest
  const agentCapabilities = manifest.permissions.agent
  const backends = verificationBackends(agentCapabilities)
  const hostConfig = defaultConfig(input, 'host')
  const agentConfig = defaultConfig(input, 'agent')
  const nxt = createNxtHostService(
    {
      ...verificationBinding,
      mode: 'verification',
      capabilities: () => agentCapabilities,
      config: () => agentConfig,
      hostConfig: () => hostConfig,
    },
    backends,
    { section: () => () => undefined, context: () => () => undefined, onTurnStart: () => () => undefined },
  )
  const hostNxt = createHostLayerNxt(
    {
      ...verificationBinding,
      mode: 'host',
      capabilities: () => hostLayerAsCapabilities(manifest.permissions.host),
      config: () => hostConfig,
    },
    backends,
  )
  const declaredAdapter = manifestAdapter(manifest)
  const handlers = new Map<string, ExtensionRpcHandler>()
  const tools = new Map<string, ExtensionToolDefinition>()
  const toolInvocations: Array<{ name: string; succeeded: boolean }> = []
  let disposePlugin: (() => void | Promise<void>) | undefined
  let inbound: NxtInboundHandler | undefined
  let adapterContribution: AdapterHostContributionV2 | undefined
  const registry = new AdapterRegistry()
  const registeredAdapters: Array<{ dispose(): Promise<void> }> = []
  try {
    if (input.artifact.hostEntry) {
      const factory = await importFactory(input.artifact.hostEntry, input.artifact.buildKey, 'Extension Host')
      const definition = await factory(undefined, [
        {
          harness: {
            defineTool: (tool: ExtensionToolDefinition) => tool,
            registerTool: (_context: unknown, tool: ExtensionToolDefinition) => {
              if (tools.has(tool.name)) throw new Error(`重复工具：${tool.name}`)
              tools.set(tool.name, tool)
              return () => tools.delete(tool.name)
            },
            handle: (method: string, handler: ExtensionRpcHandler) => {
              if (!method.trim() || handlers.has(method)) throw new Error(`重复或无效 RPC：${method}`)
              handlers.set(method, handler)
              return () => handlers.delete(method)
            },
            registerAdapter: (contribution: AdapterHostContributionV2) => {
              if (declaredAdapter === undefined) throw new Error('扩展清单没有声明适配器，不能注册适配器。')
              if (adapterContribution !== undefined) throw new Error('一个扩展只能注册一个适配器。')
              adapterContribution = contribution
              registeredAdapters.push(registry.register(`import:${input.revision.id}`, contribution))
              return () => undefined
            },
            onInbound: (handler: NxtInboundHandler) => {
              if (agentCapabilities?.inboundHook === undefined) {
                throw new Error('注册 harness.onInbound 需要声明 permissions.agent.inboundHook。')
              }
              if (inbound !== undefined) throw new Error('一个扩展只能注册一个入站处理函数。')
              inbound = handler
              return () => undefined
            },
            // Recorded only: a due-job handler acts on real jobs, and verification has none.
            onJob: (handler: NxtJobHandler) => {
              if (agentCapabilities?.jobs === undefined) {
                throw new Error('注册 harness.onJob 需要声明 permissions.agent.jobs。')
              }
              if (typeof handler !== 'function') throw new TypeError('harness.onJob 需要一个处理函数。')
              return () => undefined
            },
            config: () => hostConfig,
          },
          config: hostConfig,
          nxt: hostNxt,
        },
      ])
      if (definition !== undefined && definition !== null && hasAgentLayer(manifest)) {
        disposePlugin = await runPluginApply(definition, {
          tools: {
            register: (tool: ExtensionToolDefinition) => {
              tools.set(tool.name, tool)
              return () => tools.delete(tool.name)
            },
          },
          nxt,
          config: () => agentConfig,
        })
      }
    }
    if (declaredAdapter !== undefined && adapterContribution === undefined) {
      throw new Error('扩展清单声明了适配器，但 Host factory 没有注册适配器。')
    }
    const adapter =
      declaredAdapter === undefined || adapterContribution === undefined
        ? undefined
        : await verifyAdapterContribution(adapterContribution, declaredAdapter)

    // Use the same representative inputs that verified the dynamic run; absent means the historical empty call.
    const toolInputs = new Map<string, Readonly<Record<string, JsonValue>>>()
    const rpcInputs = new Map<string, JsonValue>()
    for (const contribution of manifest.contributions) {
      if (contribution.kind === 'tool' && contribution.verificationInput !== undefined) {
        toolInputs.set(contribution.name, contribution.verificationInput)
      }
      if (contribution.kind === 'rpc' && contribution.verificationInput !== undefined) {
        rpcInputs.set(contribution.method, contribution.verificationInput)
      }
    }
    for (const tool of tools.values()) {
      JsonValueSchema.parse(await tool.execute(toolInputs.get(tool.name) ?? {}))
      toolInvocations.push({ name: tool.name, succeeded: true })
    }
    for (const [method, handler] of handlers) {
      JsonValueSchema.parse(await handler(rpcInputs.get(method) ?? null, { surface: 'verification' }))
    }
    if (inbound !== undefined) {
      const declared = agentCapabilities?.inboundHook
      const decision = await inbound(VERIFICATION_INBOUND_MESSAGE, nxt)
      if (decision !== undefined && decision !== null) {
        const parsed = InboundDecisionSchema.safeParse(decision)
        if (!parsed.success) throw new Error(`入站处理函数返回了无效决定：${parsed.error.issues[0]?.message ?? ''}`)
        if (parsed.data.hideFromAgent === true && declared?.mayHide !== true) {
          throw new Error('入站处理函数返回了 hideFromAgent，但没有声明 mayHide。')
        }
        if (parsed.data.trigger === 'force' && declared?.mayForceTrigger !== true) {
          throw new Error('入站处理函数返回了 force，但没有声明 mayForceTrigger。')
        }
      }
    }
    // Context cache discipline: the same storage and call context must render byte-identical dynamic context.
    const first = await nxt.renderDynamicContext()
    const second = await nxt.renderDynamicContext()
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error(
        '动态上下文在相同输入下两次渲染结果不同；请去掉时间戳、随机数或精确计数，否则会破坏模型上下文缓存。',
      )
    }
    const clientEvidence = await verifyClient(input, handlers)
    const declaredTools = manifest.contributions.filter((entry) => entry.kind === 'tool').map(({ name }) => name)
    const declaredRpc = manifest.contributions.filter((entry) => entry.kind === 'rpc').map(({ method }) => method)
    if (declaredTools.some((name) => !tools.has(name)) || tools.size !== declaredTools.length) {
      throw new Error('Host 实际工具注册与扩展清单不一致。')
    }
    if (declaredRpc.some((method) => !handlers.has(method)) || handlers.size !== declaredRpc.length) {
      throw new Error('Host 实际界面数据接口注册与扩展清单不一致。')
    }
    return {
      contractVersion: 'nekro-nxt-extension-v5',
      origin: IMPORT_ORIGIN,
      toolInvocations,
      rpcMethods: [...handlers.keys()],
      renderedPanels: clientEvidence.renderedPanels,
      renderedToolViews: clientEvidence.renderedToolViews,
      renderedMessageRenderers: clientEvidence.renderedMessageRenderers,
      ...(clientEvidence.renderedPages.length === 0 ? {} : { renderedPages: clientEvidence.renderedPages }),
      permissions: clientEvidence.permissions,
      ...(adapter === undefined ? {} : { adapter }),
    }
  } finally {
    await disposePlugin?.()
    for (const registered of registeredAdapters) await registered.dispose()
    tools.clear()
    handlers.clear()
  }
}
