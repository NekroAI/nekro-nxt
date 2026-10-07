import { configFields, ExtensionConfigDeclarationSchema, type AgentId, type JsonValue } from '@nekro-nxt/contracts'
import type {
  DynamicAuthoringAttempt,
  DynamicAuthoringSnapshot,
  DynamicAuthoringTask,
} from '@nekro-nxt/extension-runtime'

const settingKey = (taskId: string) => `authoring-test-secrets:${taskId}`

export interface AuthoringTestSecretField {
  readonly key: string
  readonly title: string
}

export interface AuthoringTestSecretsDependencies {
  readonly getTask: (taskId: DynamicAuthoringTask['id']) => DynamicAuthoringTask | undefined
  readonly listTasks: (agentId: AgentId) => readonly DynamicAuthoringTask[]
  readonly listAttempts: (taskId: DynamicAuthoringTask['id']) => readonly DynamicAuthoringAttempt[]
  readonly snapshotForAttempt: (attempt: DynamicAuthoringAttempt) => Promise<DynamicAuthoringSnapshot>
  readonly getSetting: (key: string) => { readonly value: JsonValue; readonly revision: number } | undefined
  readonly putSetting: (key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number) => void
  readonly credentials: { save(secret: string): Promise<string>; delete(reference: string): Promise<void> }
  readonly now: () => number
}

const references = (value: JsonValue | undefined): Readonly<Record<string, string>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}

/**
 * Credentials a user types for one authoring task so a candidate can call real services before it is saved. They
 * live in the credential store, are visible only to that task's dynamic runs and are deleted when the task is saved
 * or deleted; a saved extension asks for its own credentials when it is enabled.
 */
export class AuthoringTestSecrets {
  readonly #deps: AuthoringTestSecretsDependencies

  constructor(deps: AuthoringTestSecretsDependencies) {
    this.#deps = deps
  }

  /** Secret fields of the task's latest candidate and which of them already have a test value. */
  async describe(taskId: DynamicAuthoringTask['id']): Promise<{
    readonly fields: readonly AuthoringTestSecretField[]
    readonly configured: readonly string[]
  }> {
    const attempt = this.#deps.listAttempts(taskId).at(-1)
    if (attempt === undefined) return { fields: [], configured: [] }
    const snapshot = await this.#deps.snapshotForAttempt(attempt)
    const parsed = ExtensionConfigDeclarationSchema.safeParse(snapshot.config)
    const fields = parsed.success
      ? configFields(parsed.data.schema)
          .filter((field) => field.kind === 'secret')
          .map((field) => ({ key: field.key, title: field.title }))
      : []
    const stored = references(this.#deps.getSetting(settingKey(taskId))?.value)
    return { fields, configured: fields.map(({ key }) => key).filter((key) => stored[key] !== undefined) }
  }

  /** Stores non-empty drafts and replaces earlier values; empty drafts keep what is stored. */
  async set(taskId: DynamicAuthoringTask['id'], secrets: Readonly<Record<string, string>>): Promise<void> {
    if (this.#deps.getTask(taskId) === undefined) throw new Error('创造任务不存在。')
    const { fields } = await this.describe(taskId)
    const allowed = new Set(fields.map(({ key }) => key))
    const unknown = Object.keys(secrets).filter((key) => !allowed.has(key))
    if (unknown.length > 0) throw new Error(`当前候选没有这些凭据字段：${unknown.join('、')}`)
    const current = this.#deps.getSetting(settingKey(taskId))
    const stored = { ...references(current?.value) }
    const replaced: string[] = []
    for (const [key, value] of Object.entries(secrets)) {
      if (value.trim() === '') continue
      const previous = stored[key]
      stored[key] = await this.#deps.credentials.save(value.trim())
      if (previous !== undefined) replaced.push(previous)
    }
    this.#deps.putSetting(settingKey(taskId), stored, current?.revision, this.#deps.now())
    await Promise.allSettled(replaced.map((reference) => this.#deps.credentials.delete(reference)))
  }

  /** Config value of the task currently authoring in this Episode: secret references only. */
  configForEpisode(agentId: AgentId, episodeId: string): JsonValue {
    const task = this.#deps
      .listTasks(agentId)
      .filter((candidate) => candidate.episodeId === episodeId && candidate.status !== 'completed')
      .at(-1)
    return task === undefined ? {} : references(this.#deps.getSetting(settingKey(task.id))?.value)
  }

  async clear(taskId: DynamicAuthoringTask['id']): Promise<void> {
    const current = this.#deps.getSetting(settingKey(taskId))
    const stored = references(current?.value)
    if (Object.keys(stored).length === 0) return
    this.#deps.putSetting(settingKey(taskId), {}, current?.revision, this.#deps.now())
    await Promise.allSettled(Object.values(stored).map((reference) => this.#deps.credentials.delete(reference)))
  }
}
