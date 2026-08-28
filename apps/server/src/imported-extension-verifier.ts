import { AdapterRegistry, type AdapterHostContributionV1 } from '@nekro-nxt/adapter-sdk'
import {
  AdapterClientSlotNameSchema,
  AgentClientSlotNameSchema,
  HostPageContributionSchema,
  HostUiNavigationModelSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
  type AdapterClientSlotName,
  type AgentClientSlotName,
  type HostPageContribution,
  type HostUiPermissionDeclaration,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'
import type { ImportedRevisionVerificationInput, ImportedRevisionVerifier } from '@nekro-nxt/extension-runtime'
import type { ExtensionToolDefinition } from '@nekro-nxt/extension-sdk'
import { createFakeAdapterHostContext } from '@nekro-nxt/test-harness'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

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

const descriptorDigest = (contribution: AdapterHostContributionV1): string =>
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
    Button: component,
    IconButton: component,
    Input: component,
    Textarea: component,
    Select: component,
    Switch: component,
    Tabs: compoundComponent,
    Dialog: compoundComponent,
    Popover: compoundComponent,
    Tooltip: compoundComponent,
    Field: component,
    StatusBadge: component,
    InlineFeedback: component,
    EmptyState: component,
    Spinner: component,
    PageHeader: component,
    Section: component,
    Stack: component,
    Grid: component,
    DataTable: component,
    SidePane: component,
  }
  return {
    React,
    ui,
    styles: {
      section: 'section',
      sectionHeading: 'sectionHeading',
      secondaryText: 'secondaryText',
      actionRow: 'actionRow',
      button: 'button',
      badge: 'badge',
    },
    dispose: async () => {
      for (const cleanup of [...effectCleanups].reverse()) await cleanup()
      for (const unsubscribe of [...subscriptions].reverse()) unsubscribe()
    },
  }
}

const syntheticSlotProps = (name: AgentClientSlotName | AdapterClientSlotName): Record<string, unknown> => {
  switch (name) {
    case 'agent.workbench.sections':
      return { agentId: 'agt_IMPORT', displayName: '导入验证智能体' }
    case 'extension.activation.panels':
    case 'extension.details.panels':
      return {
        agentId: 'agt_IMPORT',
        extensionId: 'ext_IMPORT',
        revisionId: 'xrv_IMPORT',
        activation: 'active',
        activationId: 'activation:import',
        runtimeStatus: 'active',
      }
    case 'channel.inspector.agent.sections':
      return {
        agentId: 'agt_IMPORT',
        channelId: 'chn_IMPORT',
        connectionId: 'con_IMPORT',
        runtimePhase: 'idle',
      }
    case 'conversation.tool.card':
      return {
        agentId: 'agt_IMPORT',
        channelId: 'chn_IMPORT',
        callId: 'call_IMPORT',
        toolName: 'import_probe',
        displayName: '导入工具',
        state: 'succeeded',
        surface: 'trajectory',
      }
    case 'conversation.message.rich':
      return {
        part: { type: 'rich', adapterKey: 'import', kind: 'probe', summary: '导入验证' },
        messageId: 'msg_IMPORT',
        channelId: 'chn_IMPORT',
      }
    case 'connection.adapter.setup':
    case 'connection.adapter.status':
    case 'connection.adapter.test':
      return { adapterKey: 'import', phase: 'active' }
    case 'channel.inspector.adapter.sections':
      return { adapterKey: 'import', connectionId: 'con_IMPORT', channelId: 'chn_IMPORT', channelKind: 'group' }
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

const verifyAdapter = async (input: ImportedRevisionVerificationInput): ReturnType<ImportedRevisionVerifier> => {
  const manifest = input.materialized.manifest
  if (!('schemaVersion' in manifest) || manifest.schemaVersion !== 3) throw new Error('Adapter 导入 Manifest 无效。')
  if (!input.artifact.hostEntry) throw new Error('Adapter 导入缺少 Host 构建产物。')
  const declaredAdapter = manifest.contributions.find((entry) => entry.kind === 'adapter')
  if (!declaredAdapter || declaredAdapter.kind !== 'adapter') throw new Error('Adapter Manifest 缺少适配器贡献。')
  const registry = new AdapterRegistry()
  let registered: ReturnType<AdapterRegistry['register']> | undefined
  const factory = await importFactory(input.artifact.hostEntry, input.artifact.buildKey, 'Adapter Host')
  const forbidden = (kind: string): never => {
    throw new Error(`Adapter 导入不能注册${kind}。`)
  }
  const definition = await factory(undefined, [
    {
      harness: {
        defineTool: () => forbidden('智能体工具'),
        registerTool: () => forbidden('智能体工具'),
        handle: () => forbidden('智能体 RPC'),
        registerAdapter: (contribution: AdapterHostContributionV1) => {
          if (registered) throw new Error('Adapter Host 只能注册一个适配器贡献。')
          registered = registry.register(`import:${input.revision.id}`, contribution)
          return () => void registered?.dispose()
        },
      },
      config: {},
    },
  ])
  recordOf(definition, 'Adapter Host factory 结果')
  const contribution = registry.list()[0]
  if (!contribution || registry.list().length !== 1) throw new Error('Adapter Host 必须注册且只能注册一个贡献。')
  const digest = descriptorDigest(contribution)
  if (contribution.descriptor.key !== declaredAdapter.key || digest !== declaredAdapter.descriptorDigest) {
    throw new Error('Adapter Host 实际注册内容与 Manifest 不一致。')
  }

  const fake = createFakeAdapterHostContext()
  const configuration: Record<string, string | number | boolean> = {}
  const credentialRefs: Record<string, string> = {}
  for (const [key, property] of Object.entries(contribution.descriptor.configSchema.properties)) {
    if (property.type === 'credential-reference') {
      const reference = `import-credential:${key}`
      credentialRefs[property.credentialKey?.trim() || key] = reference
      fake.credentials.set(reference, 'synthetic-import-secret')
    } else if (property.default !== undefined) configuration[key] = property.default
    else if (property.type === 'string') configuration[key] = 'https://adapter.example.test'
    else if (property.type === 'number') configuration[key] = 1
    else configuration[key] = false
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
    if (fake.events.length === 0) throw new Error('Adapter 本机验证没有提交任何入站事件。')
    if (receipt !== 'sent') throw new Error(`Adapter 本机验证出站结果不是 sent：${receipt}`)
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
          : new AggregateError([lifecycleError, errorOf(stopError)], 'Adapter 本机验证失败且未完整静止。')
    }
    await registered?.dispose()
  }
  if (lifecycleError !== undefined) throw errorOf(lifecycleError)

  const clientEvidence = await verifyClient(input, new Map())
  return {
    contractVersion: clientEvidence.renderedPages.length > 0 ? 'nekro-nxt-extension-v3' : 'nekro-nxt-extension-v2',
    scope: 'host-adapter',
    origin: IMPORT_ORIGIN,
    toolInvocations: [],
    rpcMethods: [],
    renderedSlots: [],
    renderedHostSlots: clientEvidence.renderedHostSlots,
    ...(clientEvidence.renderedPages.length === 0 ? {} : { renderedPages: clientEvidence.renderedPages }),
    ...(clientEvidence.renderedPages.length === 0 ? {} : { permissions: clientEvidence.permissions }),
    adapter: {
      apiVersion: 1,
      key: contribution.descriptor.key,
      descriptorDigest: digest,
      registered: true,
      started,
      stopped,
      inboundCommitted: fake.events.length > 0,
      outboundReceipt: receipt,
    },
  }
}

const verifyClient = async (
  input: ImportedRevisionVerificationInput,
  handlers: ReadonlyMap<string, (value: JsonValue) => JsonValue | Promise<JsonValue>>,
) => {
  const manifest = input.materialized.manifest
  const expectedAgentSlots =
    'schemaVersion' in manifest && manifest.schemaVersion === 2
      ? manifest.contributions.filter((entry) => entry.kind === 'client-slot').map(({ name }) => name)
      : []
  const expectedHostSlots =
    'schemaVersion' in manifest && manifest.schemaVersion === 3
      ? manifest.contributions
          .filter((entry) => entry.kind === 'host-client-slot')
          .map(({ name, key }) => ({ name, key }))
      : []
  const expectedPages: readonly HostPageContribution[] =
    'schemaVersion' in manifest && (manifest.schemaVersion === 3 || manifest.schemaVersion === 4)
      ? manifest.contributions.flatMap((entry) =>
          entry.kind === 'host-page' ? [HostPageContributionSchema.parse(entry)] : [],
        )
      : []
  const permissions: HostUiPermissionDeclaration =
    'schemaVersion' in manifest && manifest.schemaVersion === 4
      ? manifest.permissions
      : { permissions: [], networkOrigins: [] }
  if (!input.artifact.clientEntry) {
    if (expectedAgentSlots.length || expectedHostSlots.length || expectedPages.length) {
      throw new Error('Manifest 声明了 Client 贡献，但导入包缺少 Client 构建产物。')
    }
    return { renderedSlots: [], renderedHostSlots: [], renderedPages: [], permissions }
  }

  const harness = createClientHarness()
  const registrations: Array<() => void> = []
  const renderedSlots: AgentClientSlotName[] = []
  const renderedHostSlots: Array<{ name: AdapterClientSlotName; key: string }> = []
  const renderedPages: HostPageContribution[] = []
  const subscriptionsCleanup: Array<() => void> = []
  let dispose: (() => void | Promise<void>) | undefined
  const call = async (method: string, value: JsonValue = null): Promise<JsonValue> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`Client 调用了未注册的 Host RPC：${method}`)
    return JsonValueSchema.parse(await handler(value))
  }
  let evidence:
    | {
        readonly renderedSlots: readonly AgentClientSlotName[]
        readonly renderedHostSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[]
        readonly renderedPages: readonly HostPageContribution[]
        readonly permissions: HostUiPermissionDeclaration
      }
    | undefined
  let verificationError: unknown
  try {
    const factory = await importFactory(input.artifact.clientEntry, input.artifact.buildKey, 'Extension Client')
    const definition = await factory(undefined, [
      {
        React: harness.React,
        ui: harness.ui,
        styles: harness.styles,
        host: { call, subscribe: () => () => undefined },
      },
    ])
    dispose = await runPluginApply(definition, {
      ui: harness.ui,
      slots: {
        register: (options: unknown, slotComponent: unknown) => {
          const record = recordOf(options, 'Client Slot 参数')
          const nameValue = record['name']
          const componentFunction = callableOf(slotComponent, 'Client Slot 组件')
          const agent = AgentClientSlotNameSchema.safeParse(nameValue)
          if (agent.success) {
            if (!expectedAgentSlots.includes(agent.data))
              throw new Error(`Client 注册了未声明的智能体 Slot：${agent.data}`)
            componentFunction(undefined, [syntheticSlotProps(agent.data)])
            renderedSlots.push(agent.data)
          } else {
            const name = AdapterClientSlotNameSchema.parse(nameValue)
            const key = record['id']
            if (typeof key !== 'string' || !expectedHostSlots.some((slot) => slot.name === name && slot.key === key)) {
              throw new Error(`Client 注册了未声明的 Adapter Slot：${name}:${String(key)}`)
            }
            componentFunction(undefined, [syntheticSlotProps(name)])
            renderedHostSlots.push({ name, key })
          }
          let active = true
          const unregister = () => {
            active = false
          }
          registrations.push(unregister)
          return () => {
            if (active) unregister()
          }
        },
      },
      pages: {
        declarePermissions: (value: unknown) => {
          const declared = HostUiPermissionDeclarationSchema.parse(value)
          if (canonicalJson(JsonValueSchema.parse(declared)) !== canonicalJson(JsonValueSchema.parse(permissions))) {
            throw new Error('Client 声明的页面权限与 Manifest 不一致。')
          }
        },
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
          const unregister = () => undefined
          registrations.push(unregister)
          return unregister
        },
      },
    })
    const uniqueAgent = [...new Set(renderedSlots)]
    const uniqueHost = [...new Map(renderedHostSlots.map((slot) => [`${slot.name}\0${slot.key}`, slot])).values()]
    const uniquePages = [...new Map(renderedPages.map((page) => [page.entryId, page])).values()]
    if (uniqueAgent.length !== expectedAgentSlots.length)
      throw new Error('Client 未注册 Manifest 声明的全部智能体 Slot。')
    if (uniqueHost.length !== expectedHostSlots.length)
      throw new Error('Client 未注册 Manifest 声明的全部 Adapter Slot。')
    if (uniquePages.length !== expectedPages.length) throw new Error('Client 未注册 Manifest 声明的全部页面。')
    evidence = {
      renderedSlots: uniqueAgent,
      renderedHostSlots: uniqueHost,
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

const verifyAgentOrHostUi = async (input: ImportedRevisionVerificationInput): ReturnType<ImportedRevisionVerifier> => {
  const manifest = input.materialized.manifest
  const handlers = new Map<string, (value: JsonValue) => JsonValue | Promise<JsonValue>>()
  const tools = new Map<string, ExtensionToolDefinition>()
  const toolInvocations: Array<{ name: string; succeeded: boolean }> = []
  let disposePlugin: (() => void | Promise<void>) | undefined
  if (input.artifact.hostEntry) {
    const factory = await importFactory(input.artifact.hostEntry, input.artifact.buildKey, 'Extension Host')
    const forbiddenAdapter = (): never => {
      throw new Error('非 Adapter 导入不能注册适配器贡献。')
    }
    const definition = await factory(undefined, [
      {
        harness: {
          defineTool: (tool: ExtensionToolDefinition) => tool,
          registerTool: (_context: unknown, tool: ExtensionToolDefinition) => {
            if (tools.has(tool.name)) throw new Error(`重复工具：${tool.name}`)
            tools.set(tool.name, tool)
            return () => tools.delete(tool.name)
          },
          handle: (method: string, handler: (value: JsonValue) => JsonValue | Promise<JsonValue>) => {
            if (!method.trim() || handlers.has(method)) throw new Error(`重复或无效 RPC：${method}`)
            handlers.set(method, handler)
            return () => handlers.delete(method)
          },
          registerAdapter: forbiddenAdapter,
        },
        config: {},
      },
    ])
    disposePlugin = await runPluginApply(definition, {
      tools: {
        register: (tool: ExtensionToolDefinition) => {
          tools.set(tool.name, tool)
          return () => tools.delete(tool.name)
        },
      },
    })
  }
  try {
    for (const tool of tools.values()) {
      JsonValueSchema.parse(await tool.execute({}))
      toolInvocations.push({ name: tool.name, succeeded: true })
    }
    for (const handler of handlers.values()) JsonValueSchema.parse(await handler(null))
    const clientEvidence = await verifyClient(input, handlers)
    const declaredTools =
      'schemaVersion' in manifest && manifest.schemaVersion === 2
        ? manifest.contributions.filter((entry) => entry.kind === 'tool').map(({ name }) => name)
        : []
    const declaredRpc =
      'schemaVersion' in manifest && manifest.schemaVersion === 2
        ? manifest.contributions.filter((entry) => entry.kind === 'rpc').map(({ method }) => method)
        : []
    const isAgentManifest = 'schemaVersion' in manifest && manifest.schemaVersion === 2
    if (isAgentManifest && (declaredTools.some((name) => !tools.has(name)) || tools.size !== declaredTools.length)) {
      throw new Error('Host 实际工具注册与 Manifest 不一致。')
    }
    if (
      isAgentManifest &&
      (declaredRpc.some((method) => !handlers.has(method)) || handlers.size !== declaredRpc.length)
    ) {
      throw new Error('Host 实际 RPC 注册与 Manifest 不一致。')
    }
    const isHostUi = 'schemaVersion' in manifest && manifest.schemaVersion === 4
    if (isHostUi && tools.size > 0) throw new Error('Host UI 导入不能注册智能体工具。')
    return {
      contractVersion: isHostUi ? 'nekro-nxt-extension-v3' : 'nekro-nxt-extension-v1',
      ...(isHostUi ? { scope: 'host-ui' as const } : {}),
      origin: IMPORT_ORIGIN,
      toolInvocations,
      rpcMethods: [...handlers.keys()],
      renderedSlots: clientEvidence.renderedSlots,
      ...(clientEvidence.renderedPages.length === 0 ? {} : { renderedPages: clientEvidence.renderedPages }),
      ...(clientEvidence.renderedPages.length === 0 ? {} : { permissions: clientEvidence.permissions }),
    }
  } finally {
    await disposePlugin?.()
    tools.clear()
    handlers.clear()
  }
}

export const verifyImportedExtensionRevision: ImportedRevisionVerifier = (input) =>
  input.materialized.scope === 'host-adapter' ? verifyAdapter(input) : verifyAgentOrHostUi(input)
