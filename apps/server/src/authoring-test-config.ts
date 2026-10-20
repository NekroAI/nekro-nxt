import {
  configFields,
  ExtensionLayeredConfigSchema,
  validateConfigValue,
  type AgentId,
  type ConfigField,
  type ExtensionConfigLayer,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type {
  DynamicAuthoringAttempt,
  DynamicAuthoringSnapshot,
  DynamicAuthoringTask,
} from '@nekro-nxt/extension-runtime'
import { z } from 'zod'

const secretsKey = (taskId: string) => `authoring-test-secrets:${taskId}`
const valuesKey = (taskId: string) => `authoring-test-config:${taskId}`

/** A field of a candidate's configuration with the layer that declares it. */
export type CandidateConfigField = ConfigField & { readonly layer: ExtensionConfigLayer }

/** Fields the user types on the task page: credentials and plain text or number settings. */
export interface AuthoringTestConfigField {
  readonly key: string
  readonly title: string
  readonly kind: 'secret' | 'string' | 'number'
}

export interface AuthoringTestConfigDescription {
  readonly fields: readonly AuthoringTestConfigField[]
  /** Secret fields that have a test credential. */
  readonly configured: readonly string[]
  /** Values the user typed for non-secret fields. */
  readonly values: Readonly<Record<string, string | number>>
  /** Values the agent provided for non-secret fields; the user's values take precedence. */
  readonly agentValues: Readonly<Record<string, JsonValue>>
}

/** Test values a dynamic run of the task sees, kept apart by who provided them. */
export interface AuthoringTestConfigValues {
  readonly agentProvided: Readonly<Record<string, JsonValue>>
  /** Values the user typed, including references of the test credentials. */
  readonly userEntered: Readonly<Record<string, JsonValue>>
}

export interface AuthoringTestConfigDependencies {
  readonly getTask: (taskId: DynamicAuthoringTask['id']) => DynamicAuthoringTask | undefined
  readonly listTasks: (agentId: AgentId) => readonly DynamicAuthoringTask[]
  readonly listAttempts: (taskId: DynamicAuthoringTask['id']) => readonly DynamicAuthoringAttempt[]
  readonly snapshotForAttempt: (attempt: DynamicAuthoringAttempt) => Promise<DynamicAuthoringSnapshot>
  readonly getSetting: (key: string) => { readonly value: JsonValue; readonly revision: number } | undefined
  readonly putSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => void
  readonly credentials: { save(secret: string): Promise<string>; delete(reference: string): Promise<void> }
  readonly now: () => number
}

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const references = (value: JsonValue | undefined): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

/** Fields of both layers of a candidate's configuration; field names are unique across the layers. */
export const candidateConfigFields = (config: unknown): readonly CandidateConfigField[] => {
  const parsed = ExtensionLayeredConfigSchema.safeParse(config ?? {})
  if (!parsed.success) return []
  return (['host', 'agent'] as const).flatMap((layer) => {
    const schema = parsed.data[layer]?.schema
    return schema === undefined ? [] : configFields(schema).map((field) => ({ ...field, layer }))
  })
}

const fieldIssue = (field: ConfigField, value: JsonValue): string | undefined =>
  validateConfigValue({ type: 'object', dict: { [field.key]: field.node } }, { [field.key]: value }).issues[0]?.message

const CredentialBindingSchema = z.object({ credential: z.string().trim().min(1).max(64) }).strict()

/** The credential name a test value binds a secret field to, or `undefined` for any other value. */
export const testCredentialBinding = (value: JsonValue | undefined): string | undefined => {
  const parsed = CredentialBindingSchema.safeParse(value)
  return parsed.success ? parsed.data.credential : undefined
}

/**
 * Checks test values the agent provides against a candidate's configuration and returns them; `null` clears a value.
 * A secret field takes no typed value, only `{ credential: '名称' }`, which binds a named credential; whether the agent
 * may use it is decided when the values are stored.
 */
export const parseAgentTestConfig = (
  config: unknown,
  values: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  const fields = new Map(candidateConfigFields(config).map((field) => [field.key, field]))
  const unknown = Object.keys(values).filter((key) => !fields.has(key))
  if (unknown.length > 0) throw new Error(`候选的配置里没有这些字段：${unknown.join('、')}`)
  const typedSecrets = Object.entries(values).flatMap(([key, value]) => {
    const field = fields.get(key)!
    return field.kind === 'secret' && value !== null && testCredentialBinding(value) === undefined ? [field.title] : []
  })
  if (typedSecrets.length > 0) {
    throw new Error(
      `「${typedSecrets.join('」「')}」是凭据，不能直接写值。用 { "credential": "凭据名称" } 绑定一个已添加的凭据（用 nekro_nxt_credential_list 查看），缺少时用 nekro_nxt_credential_request 请管理员添加。`,
    )
  }
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key)!
    const issue = value === null || field.kind === 'secret' ? undefined : fieldIssue(field, value)
    if (issue !== undefined) throw new Error(`测试配置有误：${issue}`)
  }
  return values
}

/**
 * Configuration of one authoring task's dynamic runs, so a candidate can reach real services before it is saved.
 * The agent provides non-secret values; the user types credentials and may override text and number values on the
 * task page. Credentials live in the credential store. All of it is visible only to that task's dynamic runs and is
 * deleted when the task is saved or deleted; a saved extension is configured on its own.
 */
export class AuthoringTestConfig {
  readonly #deps: AuthoringTestConfigDependencies

  constructor(deps: AuthoringTestConfigDependencies) {
    this.#deps = deps
  }

  /** The task's latest candidate. */
  async candidate(taskId: DynamicAuthoringTask['id']): Promise<DynamicAuthoringSnapshot | undefined> {
    const attempt = this.#deps.listAttempts(taskId).at(-1)
    return attempt === undefined ? undefined : this.#deps.snapshotForAttempt(attempt)
  }

  /** Fields of the task's latest candidate; empty when it has none. */
  async fields(taskId: DynamicAuthoringTask['id']): Promise<readonly CandidateConfigField[]> {
    return candidateConfigFields((await this.candidate(taskId))?.config)
  }

  /** What the task page shows: fields the user can type, and what the user and the agent provided. */
  async describe(taskId: DynamicAuthoringTask['id']): Promise<AuthoringTestConfigDescription> {
    const fields = (await this.fields(taskId)).flatMap((field): AuthoringTestConfigField[] =>
      field.kind === 'secret' || field.kind === 'string' || field.kind === 'number'
        ? [{ key: field.key, title: field.title, kind: field.kind }]
        : [],
    )
    const secrets = references(this.#deps.getSetting(secretsKey(taskId))?.value)
    const stored = this.#values(taskId)
    const typed = new Set(fields.filter((field) => field.kind !== 'secret').map((field) => field.key))
    const secretKeys = new Set(fields.filter((field) => field.kind === 'secret').map((field) => field.key))
    return {
      fields,
      // A secret is set when the user typed one or the agent bound a named credential to it.
      configured: fields
        .filter(
          (field) =>
            field.kind === 'secret' &&
            (secrets[field.key] !== undefined || typeof stored.agent[field.key] === 'string'),
        )
        .map((field) => field.key),
      values: Object.fromEntries(
        Object.entries(stored.user).filter(
          (entry): entry is [string, string | number] =>
            typed.has(entry[0]) && (typeof entry[1] === 'string' || typeof entry[1] === 'number'),
        ),
      ),
      agentValues: Object.fromEntries(Object.entries(stored.agent).filter(([key]) => !secretKeys.has(key))),
    }
  }

  /** Stores non-empty credential drafts and replaces earlier ones; empty drafts keep what is stored. */
  async setSecrets(taskId: DynamicAuthoringTask['id'], secrets: Readonly<Record<string, string>>): Promise<void> {
    if (this.#deps.getTask(taskId) === undefined) throw new Error('创造任务不存在。')
    const allowed = new Set(
      (await this.fields(taskId)).filter((field) => field.kind === 'secret').map((field) => field.key),
    )
    const unknown = Object.keys(secrets).filter((key) => !allowed.has(key))
    if (unknown.length > 0) throw new Error(`当前候选没有这些凭据字段：${unknown.join('、')}`)
    const current = this.#deps.getSetting(secretsKey(taskId))
    const stored = { ...references(current?.value) }
    const replaced: string[] = []
    for (const [key, value] of Object.entries(secrets)) {
      if (value.trim() === '') continue
      const previous = stored[key]
      stored[key] = await this.#deps.credentials.save(value.trim())
      if (previous !== undefined) replaced.push(previous)
    }
    this.#deps.putSetting(secretsKey(taskId), stored, current?.revision, this.#deps.now())
    await Promise.allSettled(replaced.map((reference) => this.#deps.credentials.delete(reference)))
  }

  /** Stores what the user typed for text and number fields; an empty value falls back to the agent's or the default. */
  async setUserValues(
    taskId: DynamicAuthoringTask['id'],
    values: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    if (this.#deps.getTask(taskId) === undefined) throw new Error('创造任务不存在。')
    const fields = new Map(
      (await this.fields(taskId))
        .filter((field) => field.kind === 'string' || field.kind === 'number')
        .map((field) => [field.key, field]),
    )
    const unknown = Object.keys(values).filter((key) => !fields.has(key))
    if (unknown.length > 0) throw new Error(`当前候选没有这些配置项：${unknown.join('、')}`)
    const user: Record<string, JsonValue> = { ...this.#values(taskId).user }
    for (const [key, raw] of Object.entries(values)) {
      const field = fields.get(key)!
      if (typeof raw === 'string' && raw.trim() === '') {
        delete user[key]
        continue
      }
      const value = field.kind === 'number' && typeof raw === 'string' ? Number(raw.trim()) : raw
      const issue = fieldIssue(field, value)
      if (issue !== undefined) throw new Error(issue)
      user[key] = value
    }
    this.#putValues(taskId, { user })
  }

  /**
   * Stores test values the agent provided, checked against the task's latest candidate; `null` clears one. Credential
   * bindings are not stored here: `resolveCredential` turns each into a stored reference, or `undefined` when it waits
   * for an administrator (the field then keeps its previous value).
   */
  async setAgentValues(
    taskId: DynamicAuthoringTask['id'],
    values: Readonly<Record<string, JsonValue>>,
    resolveCredential: (key: string, name: string) => string | undefined = () => {
      throw new Error('这台 NekroNXT 不能在测试配置里绑定凭据。')
    },
  ): Promise<void> {
    const candidate = await this.candidate(taskId)
    if (candidate === undefined) throw new Error('这个任务还没有候选。')
    parseAgentTestConfig(candidate.config, values)
    const agent: Record<string, JsonValue> = { ...this.#values(taskId).agent }
    for (const [key, value] of Object.entries(values)) {
      const name = testCredentialBinding(value)
      if (value === null) delete agent[key]
      else if (name === undefined) agent[key] = value
      else {
        const reference = resolveCredential(key, name)
        if (reference !== undefined) agent[key] = reference
      }
    }
    this.#putValues(taskId, { agent })
  }

  /** Binds one secret field of the task's test configuration to a named credential an administrator allowed. */
  async bindCredential(taskId: DynamicAuthoringTask['id'], key: string, reference: string): Promise<void> {
    const field = (await this.fields(taskId)).find((candidate) => candidate.key === key)
    if (field?.kind !== 'secret') throw new Error(`当前候选没有凭据字段 ${key}。`)
    this.#putValues(taskId, { agent: { ...this.#values(taskId).agent, [key]: reference } })
  }

  /** Test values of the task currently authoring in this Episode. */
  configForEpisode(agentId: AgentId, episodeId: string): AuthoringTestConfigValues {
    const task = this.#deps
      .listTasks(agentId)
      .filter((candidate) => candidate.episodeId === episodeId && candidate.status !== 'completed')
      .at(-1)
    return task === undefined ? { agentProvided: {}, userEntered: {} } : this.values(task.id)
  }

  values(taskId: DynamicAuthoringTask['id']): AuthoringTestConfigValues {
    const stored = this.#values(taskId)
    return {
      agentProvided: stored.agent,
      userEntered: { ...stored.user, ...references(this.#deps.getSetting(secretsKey(taskId))?.value) },
    }
  }

  async clear(taskId: DynamicAuthoringTask['id']): Promise<void> {
    const values = this.#deps.getSetting(valuesKey(taskId))
    if (values !== undefined && Object.keys(asRecord(values.value)).length > 0) {
      this.#deps.putSetting(valuesKey(taskId), {}, values.revision, this.#deps.now())
    }
    const current = this.#deps.getSetting(secretsKey(taskId))
    const stored = references(current?.value)
    if (Object.keys(stored).length === 0) return
    this.#deps.putSetting(secretsKey(taskId), {}, current?.revision, this.#deps.now())
    await Promise.allSettled(Object.values(stored).map((reference) => this.#deps.credentials.delete(reference)))
  }

  #values(taskId: DynamicAuthoringTask['id']): {
    readonly agent: Readonly<Record<string, JsonValue>>
    readonly user: Readonly<Record<string, JsonValue>>
  } {
    const stored = asRecord(this.#deps.getSetting(valuesKey(taskId))?.value)
    return { agent: asRecord(stored['agent']), user: asRecord(stored['user']) }
  }

  #putValues(
    taskId: DynamicAuthoringTask['id'],
    change: {
      readonly agent?: Readonly<Record<string, JsonValue>>
      readonly user?: Readonly<Record<string, JsonValue>>
    },
  ): void {
    const current = this.#deps.getSetting(valuesKey(taskId))
    this.#deps.putSetting(
      valuesKey(taskId),
      { ...this.#values(taskId), ...change },
      current?.revision,
      this.#deps.now(),
    )
  }
}
