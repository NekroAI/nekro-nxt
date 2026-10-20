import {
  configFieldLevel,
  configFields,
  configSecretKeys,
  validateConfigValue,
  type AgentId,
  type ConfigField,
  type ConfigFieldLevel,
  type CredentialId,
  type ExtensionConfigLayer,
  type ExtensionConfigVersion,
  type ExtensionConfigVersionSource,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { layerConfigSchema, type ExtensionManifest } from '@nekro-nxt/extension-runtime'
import type { ExtensionConfigVersionRecord } from '@nekro-nxt/storage-sqlite'
import type { NekroRuntime } from '../bootstrap.js'
import { namedCredentialId } from '../credentials-library.js'
import { commitExtensionConfigWithSecrets, maskExtensionSecrets } from '../extension-secret-config.js'

/** One layer of configuration: the host layer, or one agent's own layer. */
export interface ExtensionConfigOwner {
  readonly extensionId: ExtensionId
  readonly layer: ExtensionConfigLayer
  /** Required for the agent layer. */
  readonly agentId?: AgentId | undefined
}

/** Who made a configuration write, recorded with the version it creates. */
export interface ExtensionConfigWriteMeta {
  readonly source: ExtensionConfigVersionSource
  readonly actorAgentId?: AgentId | undefined
  readonly requesterMemberId?: string | undefined
  readonly reason?: string | undefined
}

/** One field as configuration changes see it: its declaration and how much a change to it matters. */
export interface LeveledConfigField {
  readonly field: ConfigField
  readonly level: ConfigFieldLevel
}

/** A change an agent asks for, checked against the schema: what it writes and which fields it touches. */
export interface ExtensionConfigChange {
  /** The new non-secret values of the layer: the stored ones with the change applied. */
  readonly config: Readonly<Record<string, JsonValue>>
  /** Secret fields to bind to a named credential, or to clear (`null`). */
  readonly bindings: Readonly<Record<string, CredentialId | null>>
  /** Fields whose value or binding changes. */
  readonly changed: readonly LeveledConfigField[]
}

type Manifest = ExtensionManifest

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const same = (left: JsonValue | undefined, right: JsonValue | undefined): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** Fields the Manifest's `network: { mode: 'config' }` reads addresses from, for one layer. */
export const networkConfigFields = (
  manifest: Manifest | undefined,
  layer: ExtensionConfigLayer,
): ReadonlySet<string> => {
  const network = manifest?.permissions[layer]?.network
  return new Set(network?.mode === 'config' ? network.fields : [])
}

/** Every field of one layer with its level (智能体扩展配置与凭据 C9). */
export const leveledConfigFields = (
  manifest: Manifest | undefined,
  layer: ExtensionConfigLayer,
): readonly LeveledConfigField[] => {
  const network = networkConfigFields(manifest, layer)
  return configFields(layerConfigSchema(manifest, layer)).map((field) => ({
    field,
    level: configFieldLevel(field, network),
  }))
}

/**
 * Configuration writes and their history. The console, chat administrators and agents all write through
 * {@link ExtensionConfigService.write}, so validation, credential handling and the recorded version are the same for
 * every source; reverting writes an old version again as a new one.
 */
export class ExtensionConfigService {
  readonly #runtime: NekroRuntime
  readonly #now: () => number

  constructor(runtime: NekroRuntime, now: () => number = Date.now) {
    this.#runtime = runtime
    this.#now = now
  }

  /** The Manifest whose schema governs this layer: the agent's enabled Revision, else the installed or newest one. */
  manifest(owner: ExtensionConfigOwner): Manifest | undefined {
    const repository = this.#runtime.repository
    const revisionId =
      (owner.layer === 'agent' && owner.agentId !== undefined
        ? repository.getActivation(owner.agentId, owner.extensionId)?.extensionRevisionId
        : undefined) ??
      repository.getHostInstallation(owner.extensionId)?.extensionRevisionId ??
      repository.listExtensionRevisions(owner.extensionId).at(-1)?.id
    const revision = revisionId === undefined ? undefined : repository.getExtensionRevision(revisionId)
    return revision === undefined ? undefined : this.#runtime.extensionService.revisionManifest(revision)
  }

  /** The stored configuration of this layer; `undefined` when the extension is not installed or not enabled. */
  stored(owner: ExtensionConfigOwner): JsonValue | undefined {
    const repository = this.#runtime.repository
    if (owner.layer === 'host') return repository.getHostInstallation(owner.extensionId)?.config
    return owner.agentId === undefined ? undefined : repository.getActivation(owner.agentId, owner.extensionId)?.config
  }

  /**
   * Writes one layer and records the version. `config` holds the non-secret values; secret fields keep their stored
   * reference unless a typed value or binding replaces it.
   */
  async write(input: {
    readonly owner: ExtensionConfigOwner
    readonly config: JsonValue
    readonly secrets?: Readonly<Record<string, string>> | undefined
    readonly bindings?: Readonly<Record<string, CredentialId | null>> | undefined
    readonly meta: ExtensionConfigWriteMeta
  }): Promise<{ readonly stored: JsonValue; readonly version: ExtensionConfigVersionRecord }> {
    const runtime = this.#runtime
    const { owner } = input
    const agentId = owner.agentId
    if (owner.layer === 'agent' && agentId === undefined) throw new TypeError('Agent configuration needs an agent.')
    const manifest = this.manifest(owner)
    const result = await commitExtensionConfigWithSecrets({
      manifest,
      layer: owner.layer,
      previous: this.stored(owner),
      config: input.config,
      secrets: input.secrets,
      bindings: input.bindings,
      credentialExists: (id) => runtime.credentialLibrary.get(id) !== undefined,
      credentials: runtime.credentials,
      commit: async (config): Promise<{ readonly config: JsonValue }> =>
        owner.layer === 'host' || agentId === undefined
          ? runtime.updateHostExtensionConfig(owner.extensionId, config)
          : runtime.extensions.updateAgentConfig(agentId, owner.extensionId, config),
    })
    const version = this.#append(owner, result.config, input.meta)
    runtime.publishExtensionsChange?.()
    return { stored: result.config, version }
  }

  /**
   * Writes an agent's change and puts the previous configuration back if the extension does not come up with it.
   * The error tells what failed; the previous configuration is in effect afterwards.
   */
  async writeOrRestore(input: Parameters<ExtensionConfigService['write']>[0]): Promise<ExtensionConfigVersionRecord> {
    const { owner } = input
    const previous = this.stored(owner)
    const wasRunning = this.#running(owner)
    try {
      return (await this.write(input)).version
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // The lifecycle puts the previous mount back when the new one fails; only if that did not happen is it applied
      // again here, as a version of its own.
      if (wasRunning && !this.#running(owner) && previous !== undefined) {
        try {
          await this.#apply(owner, previous)
          this.#append(owner, previous, { ...input.meta, source: 'auto-revert', reason })
          this.#runtime.publishExtensionsChange?.()
        } catch (restoreError) {
          const detail = restoreError instanceof Error ? restoreError.message : String(restoreError)
          throw new Error(`修改没有生效，原来的配置也没能恢复：${reason}；${detail}`, { cause: error })
        }
      }
      throw new Error(`修改没有生效，扩展仍在使用原来的配置。原因：${reason}`, { cause: error })
    }
  }

  /** Records the stored configuration as a version unless it equals the newest one (used after enabling). */
  recordCurrent(owner: ExtensionConfigOwner, meta: ExtensionConfigWriteMeta): ExtensionConfigVersionRecord | undefined {
    const stored = this.stored(owner)
    if (stored === undefined) return undefined
    const latest = this.#runtime.repository.extensionConfigVersions.latestExtensionConfigVersion(this.#key(owner))
    if (latest !== undefined && same(latest.config, stored)) return undefined
    return this.#append(owner, stored, meta)
  }

  /**
   * Applies an agent's change to the stored configuration and checks it against the schema: `values` sets non-secret
   * fields (`null` resets one to its default), `credentials` binds secret fields to named credentials (`null` clears).
   */
  planChange(
    owner: ExtensionConfigOwner,
    values: Readonly<Record<string, JsonValue>>,
    credentials: Readonly<Record<string, CredentialId | null>>,
    base: JsonValue | undefined = this.stored(owner),
  ): ExtensionConfigChange {
    const manifest = this.manifest(owner)
    const fields = new Map(leveledConfigFields(manifest, owner.layer).map((entry) => [entry.field.key, entry]))
    const layerName = owner.layer === 'host' ? '本机配置' : '智能体配置'
    const unknown = [...Object.keys(values), ...Object.keys(credentials)].filter((key) => !fields.has(key))
    if (unknown.length > 0) throw new Error(`${layerName}里没有这些字段：${[...new Set(unknown)].join('、')}。`)
    const typedSecrets = Object.keys(values).filter((key) => fields.get(key)?.field.kind === 'secret')
    if (typedSecrets.length > 0) {
      throw new Error(
        `「${typedSecrets.join('」「')}」是凭据，不能直接写值。用 credentials 按名称绑定一个凭据（nekro_nxt_credential_list 查看）。`,
      )
    }
    const notSecret = Object.keys(credentials).filter((key) => fields.get(key)?.field.kind !== 'secret')
    if (notSecret.length > 0) throw new Error(`这些字段不是凭据，不能绑定凭据：${notSecret.join('、')}。`)
    const stored = asRecord(base)
    const secretKeys = configSecretKeys(layerConfigSchema(manifest, owner.layer))
    const publicStored = Object.fromEntries(Object.entries(stored).filter(([key]) => !secretKeys.includes(key)))
    const next: Record<string, JsonValue> = { ...publicStored }
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete next[key]
      else next[key] = value
    }
    const schema = layerConfigSchema(manifest, owner.layer)
    const issue = validateConfigValue(schema, next, { skipKeys: secretKeys }).issues[0]
    if (issue !== undefined) throw new Error(`${layerName}有误：${issue.message}`)
    const changed = [...fields.values()].filter(({ field }) =>
      field.kind === 'secret'
        ? Object.hasOwn(credentials, field.key) &&
          namedCredentialId(stored[field.key]) !== (credentials[field.key] ?? undefined)
        : Object.hasOwn(values, field.key) && !same(publicStored[field.key], next[field.key]),
    )
    return { config: next, bindings: credentials, changed }
  }

  /** The change that writes an earlier version again; typed credentials that were replaced since stay as they are. */
  revertChange(record: ExtensionConfigVersionRecord): {
    readonly config: Readonly<Record<string, JsonValue>>
    readonly bindings: Readonly<Record<string, CredentialId | null>>
  } {
    const owner = this.#owner(record)
    const manifest = this.manifest(owner)
    const secretKeys = configSecretKeys(layerConfigSchema(manifest, owner.layer))
    const old = asRecord(record.config)
    const current = asRecord(this.stored(owner))
    const bindings: Record<string, CredentialId | null> = {}
    for (const key of secretKeys) {
      const id = namedCredentialId(old[key])
      if (id !== undefined && this.#runtime.credentialLibrary.get(id) !== undefined) bindings[key] = id
      else if (old[key] === undefined && current[key] !== undefined) bindings[key] = null
    }
    return {
      config: Object.fromEntries(Object.entries(old).filter(([key]) => !secretKeys.includes(key))),
      bindings,
    }
  }

  /** Fields an earlier version differs in from the stored configuration. */
  revertFields(record: ExtensionConfigVersionRecord): readonly LeveledConfigField[] {
    const owner = this.#owner(record)
    const change = this.revertChange(record)
    const current = asRecord(this.stored(owner))
    return leveledConfigFields(this.manifest(owner), owner.layer).filter(({ field }) =>
      field.kind === 'secret'
        ? Object.hasOwn(change.bindings, field.key) &&
          namedCredentialId(current[field.key]) !== (change.bindings[field.key] ?? undefined)
        : !same(current[field.key], change.config[field.key]),
    )
  }

  /** Writes an earlier version again as a new version of the same layer. */
  async revert(versionId: number, meta: Omit<ExtensionConfigWriteMeta, 'source'>): Promise<ExtensionConfigVersion> {
    const record = this.version(versionId)
    const change = this.revertChange(record)
    const { version } = await this.write({
      owner: this.#owner(record),
      config: change.config,
      bindings: change.bindings,
      meta: { ...meta, source: 'revert', reason: meta.reason ?? `恢复到第 ${record.version} 版` },
    })
    return this.view(version)
  }

  version(versionId: number): ExtensionConfigVersionRecord {
    const record = this.#runtime.repository.extensionConfigVersions.getExtensionConfigVersion(versionId)
    if (record === undefined) throw new Error('没有这个配置版本。')
    return record
  }

  /** Versions of one extension or one layer, newest first. */
  versions(
    owner: ExtensionConfigOwner | { readonly extensionId: ExtensionId },
  ): readonly ExtensionConfigVersionRecord[] {
    const repository = this.#runtime.repository.extensionConfigVersions
    return 'layer' in owner
      ? repository.listExtensionConfigVersions(owner.extensionId, {
          owner: { layer: owner.layer, ...(owner.agentId === undefined ? {} : { agentId: owner.agentId }) },
        })
      : repository.listExtensionConfigVersions(owner.extensionId)
  }

  /** A version as clients see it: secret fields only say whether they were set and which credential they used. */
  view(record: ExtensionConfigVersionRecord): ExtensionConfigVersion {
    const masked = maskExtensionSecrets(this.manifest(this.#owner(record)), record.layer, record.config)
    return {
      id: record.id,
      extensionId: record.extensionId,
      layer: record.layer,
      agentId: record.agentId,
      version: record.version,
      config: masked.config,
      ...(masked.configuredSecrets === undefined ? {} : { configuredSecrets: [...masked.configuredSecrets] }),
      ...(masked.boundCredentials === undefined ? {} : { boundCredentials: { ...masked.boundCredentials } }),
      source: record.source,
      actorAgentId: record.actorAgentId,
      requesterMemberId: record.requesterMemberId,
      reason: record.reason,
      createdAt: record.createdAt,
    }
  }

  #append(
    owner: ExtensionConfigOwner,
    config: JsonValue,
    meta: ExtensionConfigWriteMeta,
  ): ExtensionConfigVersionRecord {
    return this.#runtime.repository.extensionConfigVersions.recordExtensionConfigVersion({
      ...this.#key(owner),
      config,
      source: meta.source,
      ...(meta.actorAgentId === undefined ? {} : { actorAgentId: meta.actorAgentId }),
      ...(meta.requesterMemberId === undefined ? {} : { requesterMemberId: meta.requesterMemberId }),
      ...(meta.reason === undefined ? {} : { reason: meta.reason }),
      createdAt: this.#now(),
    })
  }

  #key(owner: ExtensionConfigOwner) {
    return {
      extensionId: owner.extensionId,
      layer: owner.layer,
      ...(owner.layer === 'agent' && owner.agentId !== undefined ? { agentId: owner.agentId } : {}),
    }
  }

  #owner(record: ExtensionConfigVersionRecord): ExtensionConfigOwner {
    return {
      extensionId: record.extensionId,
      layer: record.layer,
      ...(record.agentId === null ? {} : { agentId: record.agentId }),
    }
  }

  #running(owner: ExtensionConfigOwner): boolean {
    const coordinator = this.#runtime.extensions
    return owner.layer === 'agent' && owner.agentId !== undefined
      ? coordinator.isAttached(owner.agentId, owner.extensionId)
      : coordinator.liveRevision(owner.extensionId) !== undefined
  }

  async #apply(owner: ExtensionConfigOwner, config: JsonValue): Promise<void> {
    const coordinator = this.#runtime.extensions
    if (owner.layer === 'agent' && owner.agentId !== undefined) {
      await coordinator.updateAgentConfig(owner.agentId, owner.extensionId, config)
    } else {
      await coordinator.updateHostConfig(owner.extensionId, config)
    }
  }
}
