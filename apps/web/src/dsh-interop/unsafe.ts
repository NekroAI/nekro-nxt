import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {
  ApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { HostApiContracts } from '@nekro-nxt/contracts'
import type { ExtensionClientEnvironment, ExtensionPluginFactory } from '@nekro-nxt/extension-sdk'
import type { ReactNode } from 'react'

export interface ClientPluginHandoff {
  readonly id: string
  readonly factory: (requireModule: (specifier: string) => unknown) => Record<string, unknown>
}

export interface SlotRegistryFace {
  entriesOfSlot(key: string): readonly StoredEntry[]
  register<Props extends object>(
    options: Readonly<Record<string, unknown>>,
    component: (props: Props) => ReactNode,
  ): () => void
  install(renderer: unknown): void
  renderSlot(key: 'root', owner: object): ReactNode
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`)
  return value
}

const requireMethods = (value: unknown, label: string, methods: readonly string[]): Record<string, unknown> => {
  const record = requireRecord(value, label)
  for (const method of methods) {
    if (typeof record[method] !== 'function') throw new TypeError(`${label}.${method} must be a function.`)
  }
  return record
}

const unsafeDshIdAfterSchemaValidation = <Id extends string>(value: string): Id => value as Id

/** Validate a classic DSH bundle handoff before invoking its factory. */
export const requireClientPluginHandoff = (value: unknown): ClientPluginHandoff => {
  const handoff = requireRecord(value, 'DSH Client module handoff')
  const id = handoff['id']
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('DSH Client module handoff.id must be a non-empty string.')
  }
  const factory = handoff['factory']
  if (typeof factory !== 'function') {
    throw new TypeError('DSH Client module handoff.factory must be a function.')
  }
  return {
    id,
    factory: (requireModule) =>
      requireRecord(Reflect.apply(factory, undefined, [requireModule]), 'DSH Client module factory result'),
  }
}

/** Read one runtime module namespace only after checking its object boundary. */
export const requireModuleRecord = (value: unknown, label: string): Record<string, unknown> =>
  requireRecord(value, label)

/**
 * Narrow one constructor exported by a dynamically evaluated DSH bundle.
 * The prototype method roster is the public face consumed by this Web host.
 */
export const requireConstructorExport = <Constructor>(
  moduleValue: unknown,
  exportName: string,
  prototypeMethods: readonly string[],
): Constructor => {
  const moduleRecord = requireRecord(moduleValue, 'DSH Client module')
  const candidate = moduleRecord[exportName]
  if (typeof candidate !== 'function') throw new TypeError(`DSH export ${exportName} must be a constructor.`)
  const prototype = requireRecord(candidate.prototype, `DSH export ${exportName}.prototype`)
  for (const method of prototypeMethods) {
    if (typeof prototype[method] !== 'function') {
      throw new TypeError(`DSH export ${exportName}.prototype.${method} must be a function.`)
    }
  }
  return candidate as Constructor
}

/** Validate a dynamically returned DSH service/object before exposing a narrow face. */
export const requireObjectWithMethods = <Face extends object>(
  value: unknown,
  label: string,
  methods: readonly string[],
): Face => requireMethods(value, label, methods) as Face

/** Validate the Cordis plugin shapes accepted by Context.plugin(). */
export const requireCordisPlugin = (value: unknown, label: string): Plugin => {
  if (typeof value === 'function') return value as Plugin
  const plugin = requireRecord(value, label)
  const apply = plugin['apply']
  if (typeof apply !== 'function') throw new TypeError(`${label}.apply must be a function.`)
  return {
    ...plugin,
    apply: (context: Context, config: unknown) => {
      const result: unknown = Reflect.apply(apply, plugin, [context, config])
      return result
    },
  }
}

/** Validate the runtime SlotRegistry service published through the Cordis Context proxy. */
export const requireSlotRegistry = (value: unknown, label: string): SlotRegistryFace =>
  requireObjectWithMethods<SlotRegistryFace>(value, label, ['entriesOfSlot', 'register', 'install', 'renderSlot'])

/** Bridge Host-contract Zod validation into DSH's declaration-only branded IDs. */
export const requireApprovalRequestId = (value: unknown): ApprovalRequestId =>
  unsafeDshIdAfterSchemaValidation<ApprovalRequestId>(
    HostApiContracts.dynamicApprove.request.shape.requestId.parse(value),
  )

export const requireDynamicPluginId = (value: unknown): CordisDynamicPluginId =>
  unsafeDshIdAfterSchemaValidation<CordisDynamicPluginId>(
    HostApiContracts.dynamicGetClientCode.request.shape.pluginId.parse(value),
  )

export const requireDynamicPackageId = (value: unknown): CordisDynamicPackageId =>
  unsafeDshIdAfterSchemaValidation<CordisDynamicPackageId>(
    HostApiContracts.dynamicRunHostHalf.request.shape.packageId.parse(value),
  )

export const requireDynamicPluginRunId = (value: unknown): CordisDynamicPluginRunId =>
  unsafeDshIdAfterSchemaValidation<CordisDynamicPluginRunId>(
    HostApiContracts.dynamicGetClientCode.request.shape.pluginRunId.parse(value),
  )

/** Validate a dynamically imported Extension Client factory before invoking it. */
export const requireExtensionPluginFactory = (value: unknown): ExtensionPluginFactory<ExtensionClientEnvironment> => {
  if (typeof value !== 'function') throw new TypeError('Extension Client artifact has no default factory.')
  return value as ExtensionPluginFactory<ExtensionClientEnvironment>
}

interface DynamicSlotCoreFace {
  register(options: unknown, component: unknown): unknown
}

/**
 * Bridge the intentionally open Extension SDK registration into DSH's declaration-merged SlotCore.
 * SlotCore performs its own full slot-kind validation after these minimum shape checks.
 */
export const registerDynamicSlot = (core: unknown, options: unknown, component: unknown): (() => void) => {
  const coreFace = requireObjectWithMethods<DynamicSlotCoreFace>(core, 'DSH SlotCore', ['register'])
  const registration = requireRecord(options, 'Extension Client slot options')
  const name = registration['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('Extension Client slot options.name must be a non-empty string.')
  }
  if (typeof component !== 'function') throw new TypeError('Extension Client slot component must be a function.')
  const dispose = coreFace.register(registration, component)
  if (typeof dispose !== 'function') throw new TypeError('DSH SlotCore.register() must return a disposer.')
  return () => {
    Reflect.apply(dispose, undefined, [])
  }
}
