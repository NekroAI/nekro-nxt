import { AdapterRegistry, type AdapterHostContributionV1 } from '@nekro-nxt/adapter-sdk'
import { canonicalJson } from '@nekro-nxt/core'
import type {
  ExtensionBuildArtifact,
  HostExtensionInstallationHost,
  MountedHostExtension,
  MountedHostUiExtension,
  Revision,
} from '@nekro-nxt/extension-runtime'
import type { ExtensionHostEnvironment, ExtensionRpcHandler } from '@nekro-nxt/extension-sdk'
import { JsonValueSchema } from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const descriptorDigest = (contribution: AdapterHostContributionV1): string =>
  createHash('sha256')
    .update(canonicalJson(JsonValueSchema.parse(JSON.parse(JSON.stringify(contribution.descriptor)))))
    .digest('hex')

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface AdapterHostInstallationCallbacks {
  expectedAdapter(revision: Revision): { readonly key: string; readonly descriptorDigest: string }
  assertAdapterKeyAvailable(adapterKey: string, extensionId: Revision['extensionId']): Promise<void>
  register(owner: string, contribution: AdapterHostContributionV1): Promise<{ dispose(): Promise<void> }>
  mountConnections(adapterKey: string): Promise<void>
  waitUntilSafe(adapterKey: string): Promise<void>
}

/** Loads a built Host Revision through a candidate Registry before publishing it to the product Registry. */
export class ServerAdapterHostInstallationHost implements HostExtensionInstallationHost {
  readonly #callbacks: AdapterHostInstallationCallbacks

  constructor(callbacks: AdapterHostInstallationCallbacks) {
    this.#callbacks = callbacks
  }

  assertAdapterKeyAvailable(adapterKey: string, extensionId: Revision['extensionId']): Promise<void> {
    return this.#callbacks.assertAdapterKeyAvailable(adapterKey, extensionId)
  }

  waitUntilSafe(adapterKey: string): Promise<void> {
    return this.#callbacks.waitUntilSafe(adapterKey)
  }

  async mount(revision: Revision, artifact: ExtensionBuildArtifact): Promise<MountedHostExtension> {
    if (!artifact.hostEntry) throw new Error('适配器 Extension Revision 缺少 Host 构建产物。')
    const expected = this.#callbacks.expectedAdapter(revision)
    const candidate = new AdapterRegistry()
    let candidateHandle: { dispose(): Promise<void> } | undefined
    const loaded: unknown = await import(`${pathToFileURL(artifact.hostEntry).href}?build=${artifact.buildKey}`)
    const hostFactory = isUnknownRecord(loaded) ? loaded['default'] : undefined
    if (typeof hostFactory !== 'function') throw new Error('适配器 Host 默认导出必须是 factory。')

    const forbidden = (kind: string): never => {
      throw new Error(`适配器 Revision 不能混装${kind}，请拆分为两个扩展。`)
    }
    const harness = {
      defineTool: () => forbidden('智能体工具'),
      registerTool: () => forbidden('智能体工具'),
      handle: () => forbidden('智能体 RPC'),
      registerAdapter: (contribution: AdapterHostContributionV1) => {
        if (candidateHandle) throw new Error('一个适配器 Revision 只能注册一个 Adapter Contribution。')
        candidateHandle = candidate.register(`candidate:${revision.id}`, contribution)
        return () => void candidateHandle?.dispose()
      },
    }
    const environment: ExtensionHostEnvironment = { harness, config: {} }
    await Reflect.apply(hostFactory, undefined, [environment])
    const contribution = candidate.list()[0]
    if (!contribution || candidate.list().length !== 1) {
      await candidateHandle?.dispose()
      throw new Error('适配器 Host factory 必须注册且只能注册一个 Adapter Contribution。')
    }
    if (contribution.descriptor.key !== expected.key) {
      await candidateHandle?.dispose()
      throw new Error('适配器 Host 实际注册的 key 与验证证据不一致。')
    }
    if (descriptorDigest(contribution) !== expected.descriptorDigest) {
      await candidateHandle?.dispose()
      throw new Error('适配器描述符与验证证据不一致。')
    }
    await candidateHandle?.dispose()

    const registered = await this.#callbacks.register(`extension:${revision.extensionId}`, contribution)
    try {
      await this.#callbacks.mountConnections(expected.key)
    } catch (error) {
      await registered.dispose().catch(() => undefined)
      throw error
    }
    return { adapterKey: expected.key, dispose: () => registered.dispose() }
  }

  async mountHostUi(_revision: Revision, artifact: ExtensionBuildArtifact): Promise<MountedHostUiExtension> {
    if (!artifact.hostEntry) {
      return {
        call: () => Promise.reject(new Error('这个页面扩展没有声明 Host RPC。')),
        dispose: () => Promise.resolve(),
      }
    }
    const loaded: unknown = await import(`${pathToFileURL(artifact.hostEntry).href}?build=${artifact.buildKey}`)
    const hostFactory = isUnknownRecord(loaded) ? loaded['default'] : undefined
    if (typeof hostFactory !== 'function') throw new Error('Host UI 的 Host 默认导出必须是 factory。')
    const handlers = new Map<string, ExtensionRpcHandler>()
    let disposed = false
    let disposeDefinition: (() => void | Promise<void>) | undefined
    const forbidden = (kind: string): never => {
      throw new Error(`Host UI Revision 不能注册${kind}，请拆分为独立扩展。`)
    }
    const harness = {
      defineTool: () => forbidden('智能体工具'),
      registerTool: () => forbidden('智能体工具'),
      registerAdapter: () => forbidden('适配器'),
      handle: (method: string, handler: ExtensionRpcHandler) => {
        const normalized = method.trim()
        if (!normalized || handlers.has(normalized)) throw new Error(`重复或无效的 Host UI RPC：${method}`)
        handlers.set(normalized, handler)
        return () => handlers.delete(normalized)
      },
    }
    const definition: unknown = await Reflect.apply(hostFactory, undefined, [{ harness, config: {} }])
    if (isUnknownRecord(definition) && typeof definition['apply'] === 'function') {
      const dispose: unknown = await Reflect.apply(definition['apply'], definition, [
        { tools: { register: () => forbidden('智能体工具') } },
      ])
      if (typeof dispose === 'function') {
        disposeDefinition = async () => {
          await Reflect.apply(dispose, definition, [])
        }
      }
    }
    return {
      async call(method, input) {
        if (disposed) throw new Error('Host UI Runtime 已停止。')
        const handler = handlers.get(method)
        if (!handler) throw new Error(`Host UI RPC 未注册：${method}`)
        return JsonValueSchema.parse(await handler(input))
      },
      async dispose() {
        disposed = true
        handlers.clear()
        await disposeDefinition?.()
      },
    }
  }
}
