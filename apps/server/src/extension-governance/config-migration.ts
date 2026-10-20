import {
  AgentIdSchema,
  configFields,
  type AgentId,
  type ExtensionConfigLayer,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { layerConfigSchema, type ExtensionManifest } from '@nekro-nxt/extension-runtime'
import type { NekroRuntime } from '../bootstrap.js'
import type { ExtensionConfigWriteMeta } from './config-service.js'
import { maskExtensionSecrets } from '../extension-secret-config.js'
import { activationManifest } from '../host-queries.js'
import type { ExtensionDataSource } from './data-service.js'

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

/** Fields of one layer that a migration may write: everything the target declares except credentials. */
const plainFields = (manifest: ExtensionManifest | undefined, layer: ExtensionConfigLayer): readonly string[] => {
  const schema = manifest === undefined ? undefined : layerConfigSchema(manifest, layer)
  return schema === undefined
    ? []
    : configFields(schema)
        .filter((field) => field.kind !== 'secret')
        .map((field) => field.key)
}

const secretFields = (manifest: ExtensionManifest | undefined, layer: ExtensionConfigLayer): readonly string[] => {
  const schema = manifest === undefined ? undefined : layerConfigSchema(manifest, layer)
  return schema === undefined
    ? []
    : configFields(schema)
        .filter((field) => field.kind === 'secret')
        .map((field) => field.key)
}

/** Overwrite keeps the target's other settings; replace starts from defaults. Credentials stay as they are. */
const merged = (
  target: JsonValue | undefined,
  source: JsonValue | undefined,
  mode: 'overwrite' | 'replace',
  writable: readonly string[],
  secrets: readonly string[],
): { readonly value: JsonValue; readonly changed: readonly string[] } => {
  const current = asRecord(target)
  const incoming = asRecord(source)
  const base: Record<string, JsonValue> =
    mode === 'overwrite'
      ? { ...current }
      : Object.fromEntries(Object.entries(current).filter(([key]) => secrets.includes(key)))
  const changed: string[] = []
  for (const key of writable) {
    if (incoming[key] === undefined) continue
    if (JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) changed.push(key)
    base[key] = incoming[key]
  }
  if (mode === 'replace') {
    for (const key of writable) if (incoming[key] === undefined && current[key] !== undefined) changed.push(key)
  }
  return { value: base, changed }
}

export interface ConfigMigrationPlan {
  readonly source: ExtensionDataSource
  readonly targetExtensionId: ExtensionId
  readonly mode: 'overwrite' | 'replace'
  readonly agentMap?: Readonly<Record<string, AgentId>>
}

export interface ConfigMigrationChanges {
  /** Host configuration fields that would change. */
  readonly hostFields: readonly string[]
  /** Agents whose configuration would change, with the fields. */
  readonly agents: readonly { readonly agentId: AgentId; readonly fields: readonly string[] }[]
}

/**
 * Moves configuration along with data: the host configuration and each agent's configuration, mapped the same way as
 * the agents' data. Credentials never move; the target keeps its own. Snapshots hold data only.
 */
export class ExtensionConfigMigration {
  readonly #runtime: NekroRuntime

  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }

  preview(plan: ConfigMigrationPlan): ConfigMigrationChanges {
    return this.#plan(plan).changes
  }

  /** Writes the moved configuration; each changed layer is recorded as a configuration version from `source`. */
  async apply(
    plan: ConfigMigrationPlan,
    source: ExtensionConfigWriteMeta['source'] = 'console',
  ): Promise<ConfigMigrationChanges> {
    const { changes, host, agents } = this.#plan(plan)
    const coordinator = this.#runtime.extensions
    const config = this.#runtime.extensionConfig
    const meta = { source, reason: '随数据迁移' }
    if (host !== undefined && changes.hostFields.length > 0) {
      await coordinator.updateHostConfig(plan.targetExtensionId, host)
      config.recordCurrent({ extensionId: plan.targetExtensionId, layer: 'host' }, meta)
    }
    for (const entry of agents) {
      if (entry.fields.length > 0) {
        await coordinator.updateAgentConfig(entry.agentId, plan.targetExtensionId, entry.value)
        config.recordCurrent({ extensionId: plan.targetExtensionId, layer: 'agent', agentId: entry.agentId }, meta)
      }
    }
    return changes
  }

  #plan(plan: ConfigMigrationPlan) {
    const runtime = this.#runtime
    const source = this.#sourceConfig(plan)
    const installation = runtime.repository.getHostInstallation(plan.targetExtensionId)
    const hostManifest = activationManifest(runtime, installation?.extensionRevisionId)
    const host =
      installation === undefined || source.host === undefined
        ? undefined
        : merged(
            installation.config,
            source.host,
            plan.mode,
            plainFields(hostManifest, 'host'),
            secretFields(hostManifest, 'host'),
          )
    const agents = runtime.repository
      .listActivations()
      .filter((activation) => activation.extensionId === plan.targetExtensionId)
      .flatMap((activation) => {
        const sourceAgent =
          plan.agentMap === undefined
            ? activation.agentId
            : Object.entries(plan.agentMap).find(([, target]) => target === activation.agentId)?.[0]
        const incoming = sourceAgent === undefined ? undefined : source.agents[sourceAgent]
        if (incoming === undefined) return []
        const manifest = activationManifest(runtime, activation.extensionRevisionId)
        const result = merged(
          activation.config,
          incoming,
          plan.mode,
          plainFields(manifest, 'agent'),
          secretFields(manifest, 'agent'),
        )
        return [{ agentId: activation.agentId, value: result.value, fields: result.changed }]
      })
    return {
      host: host?.value,
      agents,
      changes: {
        hostFields: host?.changed ?? [],
        agents: agents.filter((entry) => entry.fields.length > 0).map(({ agentId, fields }) => ({ agentId, fields })),
      },
    }
  }

  #sourceConfig(plan: ConfigMigrationPlan): {
    readonly host?: JsonValue
    readonly agents: Readonly<Record<string, JsonValue>>
  } {
    const runtime = this.#runtime
    switch (plan.source.kind) {
      case 'extension': {
        const extensionId = plan.source.extensionId
        const installation = runtime.repository.getHostInstallation(extensionId)
        // Credential references of the source stay with the source.
        return {
          ...(installation === undefined
            ? {}
            : {
                host: maskExtensionSecrets(
                  activationManifest(runtime, installation.extensionRevisionId),
                  'host',
                  installation.config,
                ).config,
              }),
          agents: Object.fromEntries(
            runtime.repository
              .listActivations()
              .filter((activation) => activation.extensionId === extensionId)
              .map((activation) => [
                AgentIdSchema.parse(activation.agentId),
                maskExtensionSecrets(
                  activationManifest(runtime, activation.extensionRevisionId),
                  'agent',
                  activation.config,
                ).config,
              ]),
          ),
        }
      }
      case 'package': {
        const config = runtime.extensionData.packageManifest(plan.source.token)?.config
        return { ...(config?.host === undefined ? {} : { host: config.host }), agents: config?.agents ?? {} }
      }
      case 'snapshot':
        return { agents: {} }
    }
  }
}
