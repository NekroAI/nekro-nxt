import {
  configFieldLevel,
  configSecretKeys,
  parseJsonValue,
  validateConfigValue,
  type AgentId,
  type ChannelId,
  type ConfigFieldLevel,
  type CredentialId,
  type CredentialUsage,
  type EpisodeId,
  type ExtensionId,
  type ExtensionLayeredConfig,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  editableRevisionSources,
  type DynamicAuthoringSnapshot,
  type DynamicAuthoringTask,
  type LocalExtension,
  type Revision,
} from '@nekro-nxt/extension-runtime'
import { candidateConfigFields, testCredentialBinding, type CandidateConfigField } from '../authoring-test-config.js'
import { commandEnvName, namedCredentialId, namedCredentialReference } from '../credentials-library.js'
import { modelProviderAccessList } from '../host-routes-credentials.js'
import type { NekroRuntime } from '../bootstrap.js'
import { redactLogText } from '../logs/redact.js'
import type { ExtensionAction } from './actions.js'
import { extensionVersions } from './versions.js'

/** The definition of a stored Revision in the shape `nekro_nxt_extension_define` takes, plus how it was written. */
export interface RevisionDefinition {
  readonly snapshot: DynamicAuthoringSnapshot
  readonly codeFormat: 'body' | 'module'
}

export interface RevisePreparation {
  readonly extensionId: ExtensionId
  readonly extensionName: string
  readonly baseRevisionId: ExtensionRevisionId
  readonly baseLabel: string
  readonly base: RevisionDefinition
  readonly referenceRevisionId?: ExtensionRevisionId
  readonly referenceLabel?: string
  readonly reference?: RevisionDefinition
  /** The extension's unfinished revise task, which the tool continues instead of starting another. */
  readonly openTask?: DynamicAuthoringTask
  /** Short lowercase prefix for the candidate's plugin id. */
  readonly idPrefix: string
}

export type TurnRequester =
  { readonly kind: 'admin' } | { readonly kind: 'member'; readonly memberId: string } | { readonly kind: 'self' }

export interface ToolActionOutcome {
  readonly outcome: 'done' | 'scheduled' | 'requested' | 'console'
  readonly message: string
  readonly requestNumber?: number
}

/** What the agent's extension tools need from the host; implemented over the runtime's governance services. */
export interface ExtensionGovernanceToolPort {
  /** Whether the message that started this turn may start or change extension work for this agent. */
  requesterAllowed(
    agentId: AgentId,
    episodeId: EpisodeId,
  ): { readonly allowed: true } | { readonly allowed: false; readonly reason: string }
  /**
   * Who asked for this turn: an administrator (also the console and the built-in channel), a channel member, or
   * nobody (the agent woke up on its own, for example after a system notice).
   */
  requester(agentId: AgentId, episodeId: EpisodeId): TurnRequester
  /**
   * Whether this agent's candidates run without anyone approving them: its extension autonomy is autonomous, or the
   * older automatic setting is on.
   */
  runsWithoutAsking(agentId: AgentId): boolean
  list(agentId: AgentId): JsonValue
  prepareRevise(
    agentId: AgentId,
    input: { readonly extension: string; readonly version?: string; readonly reference?: string },
  ): Promise<RevisePreparation>
  act(
    agentId: AgentId,
    channelId: ChannelId,
    action: ExtensionAction,
    requester?: TurnRequester,
  ): Promise<ToolActionOutcome>
  /** A task of this agent that can move into the current conversation: paused, interrupted or left in another one. */
  continuableTask(agentId: AgentId, episodeId: EpisodeId, reference: string | undefined): DynamicAuthoringTask
  resolveExtension(agentId: AgentId, reference: string): LocalExtension
  resolveTask(agentId: AgentId, reference: string | undefined): DynamicAuthoringTask
  /** A Revision of the extension by its version label (`v2`, `v3·2`). */
  revisionByLabel(extensionId: ExtensionId, label: string): ExtensionRevisionId
  /** The installed Revision, or the newest one when not installed. */
  currentRevision(extensionId: ExtensionId): ExtensionRevisionId
  /**
   * Configuration, problems, runtime state and the agent's authority for one extension it can see, or for one of its
   * authoring tasks. Never returns credentials or another agent's own configuration.
   */
  inspect(
    agentId: AgentId,
    target: { readonly kind: 'extension' | 'task'; readonly reference: string | undefined },
    requester?: TurnRequester,
  ): Promise<JsonValue>
  /** A configuration version of this extension by its number in one layer, for `revert_config`. */
  configVersion(
    agentId: AgentId,
    extensionId: ExtensionId,
    layer: 'host' | 'agent',
    version: number,
  ): { readonly id: number }
  /** The configuration declaration of a saved Revision; candidates revising it keep its administrator-only fields. */
  revisionConfig(revisionId: ExtensionRevisionId): ExtensionLayeredConfig | undefined
  /**
   * Stores test values the agent provides for one of its tasks, checked against the task's latest candidate. Secret
   * fields bound to a credential whose automatic use is off file a request instead; the result says so.
   */
  setTestConfig(
    taskId: DynamicAuthoringTask['id'],
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<{ readonly notes: readonly string[] }>
  /**
   * Checks credential bindings in test values before a definition is recorded: unknown credentials and ones not open to
   * the agent fail; the result notes the ones that will wait for an administrator.
   */
  checkTestCredentials(agentId: AgentId, values: Readonly<Record<string, JsonValue>>): readonly string[]
  /** Named credentials and open model providers as the agent may know them: names and rules, never values. */
  listCredentials(agentId: AgentId): Promise<JsonValue>
  /** Asks an administrator to add a credential; the agent is woken in this channel once one with the name exists. */
  requestCredential(
    agentId: AgentId,
    channelId: ChannelId,
    input: {
      readonly name: string
      readonly purpose: string
      readonly domains: readonly string[]
      readonly usage: CredentialUsage
    },
  ): JsonValue
}

type ConfigLayer = CandidateConfigField['layer']

/** Permissions as both a saved Manifest and a candidate declare them; only network config fields matter here. */
type NetworkLayer = { readonly network?: { readonly mode: string; readonly fields?: readonly string[] } | undefined }
interface NetworkDeclaration {
  readonly host?: NetworkLayer | undefined
  readonly agent?: NetworkLayer | undefined
}

const INSPECT_LOG_LIMIT = 5
const INSPECT_HISTORY = 5

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const networkFields = (permissions: NetworkDeclaration, layer: ConfigLayer): ReadonlySet<string> => {
  const network = permissions[layer]?.network
  return new Set(network?.mode === 'config' ? (network.fields ?? []) : [])
}

/**
 * One field as the agent sees it. `level` says how a change is handled: `secret` values are never shown, only whether
 * they are set or which credential they are bound to; `network` values decide which addresses the extension may reach;
 * `admin` fields are changed by an administrator in the console only.
 */
const describeField = (
  field: CandidateConfigField,
  permissions: NetworkDeclaration,
  current: { readonly values: Readonly<Record<string, JsonValue>> } | undefined,
  credentialName: (id: CredentialId) => string | undefined,
) => {
  const level = configFieldLevel(field, networkFields(permissions, field.layer))
  const stored = current?.values[field.key]
  return {
    layer: field.layer,
    key: field.key,
    title: field.title,
    ...(field.hint === undefined ? {} : { hint: field.hint }),
    type: field.kind === 'secret' ? 'string' : field.kind,
    ...(field.options === undefined ? {} : { options: field.options.map((option) => option.value) }),
    required: field.required,
    ...(field.default === undefined ? {} : { default: field.default }),
    level,
    ...(current === undefined
      ? {}
      : field.kind === 'secret'
        ? secretState(stored, credentialName)
        : stored === undefined
          ? {}
          : { value: stored }),
  }
}

/** Whether a secret field is set, and the credential's name when it is bound to one; never the value. */
const secretState = (stored: JsonValue | undefined, credentialName: (id: CredentialId) => string | undefined) => {
  const id = namedCredentialId(stored)
  if (id === undefined) return { set: typeof stored === 'string' && stored !== '' }
  const name = credentialName(id)
  return name === undefined ? { set: false, credentialRemoved: true } : { set: true, credential: name }
}

/** What is wrong with one layer's values: validation issues and required credentials still missing. */
const layerProblems = (
  fields: readonly CandidateConfigField[],
  layer: ConfigLayer,
  values: Readonly<Record<string, JsonValue>>,
  label: string,
): string[] => {
  const own = fields.filter((field) => field.layer === layer)
  if (own.length === 0) return []
  const schema = { type: 'object' as const, dict: Object.fromEntries(own.map((field) => [field.key, field.node])) }
  const secrets = configSecretKeys(schema)
  const plain = Object.fromEntries(
    Object.entries(values).filter(([key]) => Object.hasOwn(schema.dict, key) && !secrets.includes(key)),
  )
  return [
    ...validateConfigValue(schema, plain, { skipKeys: secrets }).issues.map((issue) => `${label}：${issue.message}`),
    ...own
      .filter((field) => field.kind === 'secret' && field.required && typeof values[field.key] !== 'string')
      .map((field) => `${label}缺少凭据「${field.title}」。`),
  ]
}

/** Actions that change what is mounted for agents, so they wait until the agent is between turns. */
const LANDS_AFTER_TURN: ReadonlySet<ExtensionAction['kind']> = new Set([
  'enable',
  'revert-config',
  'disable',
  'switch',
  'revert',
  'migrate-data',
  'community-update',
  'community-install',
])

const prefixFrom = (slug: string): string => {
  const letters = slug.toLowerCase().replaceAll(/[^a-z]/gu, '')
  return letters.length >= 3 ? letters.slice(0, 6) : 'rev'
}

/** The agent-facing governance port: local extensions are shared within the agent's delegated autonomy. */
export class ExtensionGovernanceTools implements ExtensionGovernanceToolPort {
  readonly #runtime: NekroRuntime

  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }

  runsWithoutAsking(agentId: AgentId): boolean {
    const revision = this.#runtime.repository.getAgent(agentId)?.revision
    return (
      revision?.capabilities.extensionAutonomy === 'autonomous' || revision?.dynamicClientApprovalPolicy === 'automatic'
    )
  }

  requesterAllowed(agentId: AgentId, episodeId: EpisodeId) {
    const agent = this.#runtime.repository.getAgent(agentId)
    if (agent?.revision.capabilities.extensionRequesters !== 'admins') return { allowed: true as const }
    // A turn nobody asked for (the agent woke up on its own) continues work an administrator allowed earlier.
    return this.requester(agentId, episodeId).kind === 'member'
      ? {
          allowed: false as const,
          reason: '这个智能体只接受 NekroNXT 管理员提出的扩展制作和修改；请礼貌地告诉对方需要管理员来提。',
        }
      : { allowed: true as const }
  }

  requester(_agentId: AgentId, episodeId: EpisodeId): TurnRequester {
    const runtime = this.#runtime
    const episode = runtime.repository.getEpisode(episodeId)
    const eventId = episode?.lastAdmittedEventId ?? episode?.openedAtEventId
    const event = eventId === undefined ? undefined : runtime.repository.getChannelEvent(eventId)
    const channel = episode === undefined ? undefined : runtime.repository.getChannel(episode.channelId)
    // The built-in channel and the console speak for an administrator.
    if (channel?.kind === 'internal' || event?.facts?.['consoleAnchor'] === true) return { kind: 'admin' }
    if (event?.senderMemberId === undefined) return { kind: 'self' }
    const identity =
      channel === undefined
        ? undefined
        : runtime.core.resolveChannelMemberIdentity(channel.connectionId, channel.id, event.senderMemberId)
    return runtime.administrators.isAdministrator(channel?.connectionId, identity?.platformUserId)
      ? { kind: 'admin' }
      : { kind: 'member', memberId: event.senderMemberId }
  }

  list(agentId: AgentId): JsonValue {
    const runtime = this.#runtime
    const extensions = this.#visibleExtensions(agentId)
    const autonomy = runtime.repository.getAgent(agentId)?.revision.capabilities.extensionAutonomy ?? 'manual'
    return {
      autonomy,
      scope: autonomy === 'manual' ? 'related' : 'local',
      ...(autonomy === 'manual'
        ? {
            scopeReason:
              '扩展自主权是「手动」，这里只列出与你相关的扩展。请管理员在智能体能力里调整扩展自主权后管理本机扩展。',
          }
        : {}),
      extensions: extensions.map((extension) => {
        const versions = extensionVersions(runtime.repository, runtime.extensionService, extension.id)
        const current = runtime.repository.getHostInstallation(extension.id)?.extensionRevisionId
        const sync = runtime.communitySync.cachedItem(extension.id)
        const task = runtime.repository.getOpenRevisionTask(extension.id)
        const enablement = runtime.extensionActions.assess(
          { kind: 'enable', extensionId: extension.id, agentId },
          { kind: 'agent', agentId },
        )
        const enabled = runtime.repository.getActivation(agentId, extension.id) !== undefined
        const note =
          (enabled ? undefined : runtime.extensionActions.enablementMissing(agentId, extension.id)) ??
          runtime.extensionActions.enablementNote(agentId, extension.id)
        return {
          id: extension.id,
          name: extension.displayName,
          slug: extension.slug,
          createdByYou: extension.createdByAgentId === agentId,
          enabledForYou: enabled,
          currentVersion: current === undefined ? null : (versions.get(current)?.label ?? null),
          installed: current !== undefined,
          availableVersion:
            (current === undefined ? [...versions.values()].at(-1) : versions.get(current))?.label ?? null,
          enablement: {
            decision: enablement.decision,
            ...(enablement.reason === undefined ? {} : { reason: enablement.reason }),
            ...(note === undefined ? {} : { note }),
          },
          versions: [...versions.values()].map((version) => version.label),
          dataVersion: runtime.extensionData.dataVersion(extension.id),
          ...(extension.branchOf === undefined ? {} : { branchOf: extension.branchOf.extensionId }),
          community:
            sync === undefined ? null : { role: sync.role, status: sync.status, latest: sync.latest?.number ?? null },
          ...(task?.agentId !== agentId ? {} : { openTask: { id: task.id, status: task.status } }),
        }
      }),
      tasks: runtime.repository
        .listAuthoringTasks(agentId)
        .filter((task) => !['completed', 'stopped'].includes(task.status))
        .map((task) => ({ id: task.id, title: task.title, kind: task.kind, status: task.status })),
      pendingRequests: runtime.extensionRequests
        .list('pending')
        .filter((request) => request.agentId === agentId)
        .map((request) => ({ number: request.number, summary: request.summary })),
    }
  }

  async prepareRevise(
    agentId: AgentId,
    input: { readonly extension: string; readonly version?: string; readonly reference?: string },
  ): Promise<RevisePreparation> {
    const runtime = this.#runtime
    const extension = this.resolveExtension(agentId, input.extension)
    const versions = extensionVersions(runtime.repository, runtime.extensionService, extension.id)
    const byLabel = (label: string): Revision => {
      const normalized = label
        .trim()
        .toLowerCase()
        .replace(/^(?!v)/u, 'v')
      const match = [...versions.values()].find((version) => version.label.toLowerCase() === normalized)
      const revision = match === undefined ? undefined : runtime.repository.getExtensionRevision(match.revisionId)
      if (!revision) throw new Error(`「${extension.displayName}」没有版本 ${label}。`)
      return revision
    }
    const installed = runtime.repository.getHostInstallation(extension.id)?.extensionRevisionId
    const base =
      input.version !== undefined
        ? byLabel(input.version)
        : (runtime.repository.listExtensionRevisions(extension.id).find((revision) => revision.id === installed) ??
          runtime.repository.listExtensionRevisions(extension.id).at(-1))
    if (!base) throw new Error(`「${extension.displayName}」没有可用的版本。`)
    if (runtime.extensionService.revisionFormat(base) !== 'current') {
      throw new Error('这个版本是旧格式，没法在它的基础上修改；请从社区获取新版，或者重新做一个。')
    }
    const reference = input.reference === undefined ? undefined : byLabel(input.reference)
    const openTask = runtime.repository.getOpenRevisionTask(extension.id)
    if (openTask !== undefined && openTask.agentId !== agentId) {
      throw new Error('这个扩展已有其他智能体的修改任务，请等它完成后再修改。')
    }
    return {
      extensionId: extension.id,
      extensionName: extension.displayName,
      baseRevisionId: base.id,
      baseLabel: versions.get(base.id)?.label ?? '',
      base: await this.#definition(extension, base),
      ...(reference === undefined
        ? {}
        : {
            referenceRevisionId: reference.id,
            referenceLabel: versions.get(reference.id)?.label ?? '',
            reference: await this.#definition(extension, reference),
          }),
      ...(openTask === undefined ? {} : { openTask }),
      idPrefix: prefixFrom(extension.slug),
    }
  }

  async act(
    agentId: AgentId,
    channelId: ChannelId,
    action: ExtensionAction,
    requester: TurnRequester = { kind: 'self' },
  ): Promise<ToolActionOutcome> {
    const runtime = this.#runtime
    const actor = {
      kind: 'agent' as const,
      agentId,
      channelId,
      requester: requester.kind === 'admin' ? ('admin' as const) : ('member' as const),
    }
    // A configuration change keeps naming the agent it came from, also when an administrator carries it out later.
    if (
      (action.kind === 'configure' || action.kind === 'revert-config' || action.kind === 'enable') &&
      action.actorAgentId === undefined
    ) {
      action = { ...action, actorAgentId: agentId }
    }
    if (action.kind === 'enable') {
      // Missing values the agent can give itself are its to fix, not an administrator's.
      const missing =
        runtime.extensionActions.enablementProblem(action.agentId, action.extensionId) === undefined
          ? runtime.extensionActions.enablementMissing(action.agentId, action.extensionId, action.values)
          : undefined
      if (missing !== undefined) throw new Error(missing)
    }
    if (action.kind === 'configure' || action.kind === 'revert-config') {
      // Wrong fields, values or credential names fail here, before anything is asked or scheduled.
      const plan = runtime.extensionActions.configPlan(action)
      if (runtime.extensionConfig.stored(plan.owner) === undefined) {
        throw new Error(
          plan.owner.layer === 'host'
            ? '这个扩展还没有安装到本机，本机配置要在安装后才能修改。'
            : '还没有给你启用这个扩展；用 enable 启用，可以在 values 里一起带上配置。',
        )
      }
      if (plan.change.changed.length === 0) return { outcome: 'done', message: '配置没有变化。' }
    }
    const assessment = runtime.extensionActions.assess(action, actor)
    if (assessment.decision === 'console') {
      return { outcome: 'console', message: assessment.reason ?? '这件事需要管理员在 NekroNXT 后台操作。' }
    }
    if (assessment.decision === 'request') {
      const record = runtime.extensionRequests.create({ action, actor, assessment })
      return {
        outcome: 'requested',
        requestNumber: record.number,
        message: `${assessment.reason ?? '需要管理员确认。'}已在频道里发出请求 #${record.number}，管理员确认后会自动执行并通知你。`,
      }
    }
    if (action.kind === 'configure') {
      const scheduled = runtime.extensionRequests.scheduleConfigure({ action, actor })
      return {
        outcome: 'scheduled',
        message:
          scheduled === 'merged'
            ? '已并入这次回复里前面的配置修改，回复结束后一起生效。'
            : '会在这次回复结束后生效；同一次回复里对这一层配置的多次修改会合并成一次。完成后会以系统通知告诉你。',
      }
    }
    if (LANDS_AFTER_TURN.has(action.kind)) {
      // These wait for the agent's safe gap, which comes only after this very turn: they land in the background.
      runtime.extensionRequests.runAfterTurn({ action, actor, assessment })
      return {
        outcome: 'scheduled',
        message:
          '已开始，会在这次回复结束后生效；完成后频道里会有通知，也会以系统通知告诉你。这次回复里先别调用新工具或测试它，告诉用户等一下即可。',
      }
    }
    const result = await runtime.extensionActions.perform(action, actor)
    runtime.extensionRequests.recordAutonomous({ action, actor, assessment, result })
    return { outcome: 'done', message: result.message }
  }

  configVersion(agentId: AgentId, extensionId: ExtensionId, layer: 'host' | 'agent', version: number) {
    const found = this.#runtime.extensionConfig
      .versions({ extensionId, layer, ...(layer === 'agent' ? { agentId } : {}) })
      .find((record) => record.version === version)
    if (found === undefined) {
      throw new Error(
        `没有第 ${version} 版${layer === 'host' ? '本机' : '你的'}配置。用 nekro_nxt_extension_inspect 查看配置历史。`,
      )
    }
    return { id: found.id }
  }

  revisionConfig(revisionId: ExtensionRevisionId): ExtensionLayeredConfig | undefined {
    const revision = this.#runtime.repository.getExtensionRevision(revisionId)
    return revision === undefined ? undefined : this.#runtime.extensionService.revisionManifest(revision)?.config
  }

  continuableTask(agentId: AgentId, episodeId: EpisodeId, reference: string | undefined): DynamicAuthoringTask {
    const task = this.resolveTask(agentId, reference)
    if (task.status === 'completed' || task.status === 'stopped') throw new Error(`任务「${task.title}」已经结束。`)
    if (task.episodeId === episodeId && !['paused', 'interrupted'].includes(task.status)) {
      throw new Error(`任务「${task.title}」已经在这个对话里，直接接着做就行。`)
    }
    return task
  }

  resolveExtension(agentId: AgentId, reference: string): LocalExtension {
    const runtime = this.#runtime
    const query = reference.trim()
    const all = this.#visibleExtensions(agentId)
    const own = all.filter(
      (extension) =>
        extension.createdByAgentId === agentId || runtime.repository.getActivation(agentId, extension.id) !== undefined,
    )
    const match = (list: readonly LocalExtension[]) =>
      list.find((extension) => extension.id === query || extension.displayName === query || extension.slug === query) ??
      list.find((extension) => extension.displayName.includes(query))
    const exact = all.find((extension) => extension.id === query || extension.slug === query)
    const found = exact ?? match(own) ?? match(all)
    if (!found) throw new Error(`找不到可访问的扩展「${query}」。请用 nekro_nxt_extension_list 查看范围和扩展编号。`)
    return found
  }

  #visibleExtensions(agentId: AgentId): readonly LocalExtension[] {
    const runtime = this.#runtime
    const all = runtime.repository.listExtensions()
    if ((runtime.repository.getAgent(agentId)?.revision.capabilities.extensionAutonomy ?? 'manual') !== 'manual')
      return all
    const tasks = runtime.repository.listAuthoringTasks(agentId)
    return all.filter(
      (extension) =>
        extension.createdByAgentId === agentId ||
        runtime.repository.getActivation(agentId, extension.id) !== undefined ||
        tasks.some((task) => task.targetExtensionId === extension.id),
    )
  }

  resolveTask(agentId: AgentId, reference: string | undefined): DynamicAuthoringTask {
    const tasks = this.#runtime.repository
      .listAuthoringTasks(agentId)
      .filter((task) => !['completed', 'stopped'].includes(task.status))
    const query = reference?.trim()
    const found =
      query === undefined || query === ''
        ? tasks.length === 1
          ? tasks[0]
          : undefined
        : (tasks.find((task) => task.id === query || task.title === query) ??
          tasks.find((task) => task.title.includes(query)))
    if (!found) throw new Error(query ? `找不到任务「${query}」。` : '有好几个进行中的任务，请写上任务名称或编号。')
    return found
  }

  revisionByLabel(extensionId: ExtensionId, label: string): ExtensionRevisionId {
    const normalized = label
      .trim()
      .toLowerCase()
      .replace(/^(?!v)/u, 'v')
    for (const version of extensionVersions(
      this.#runtime.repository,
      this.#runtime.extensionService,
      extensionId,
    ).values()) {
      if (version.label.toLowerCase() === normalized) return version.revisionId
    }
    throw new Error(`没有版本 ${label}。`)
  }

  currentRevision(extensionId: ExtensionId): ExtensionRevisionId {
    const installed = this.#runtime.repository.getHostInstallation(extensionId)?.extensionRevisionId
    const revisions = this.#runtime.repository.listExtensionRevisions(extensionId)
    const revision = revisions.find((candidate) => candidate.id === installed) ?? revisions.at(-1)
    if (!revision) throw new Error('这个扩展没有可用的版本。')
    return revision.id
  }

  async inspect(
    agentId: AgentId,
    target: { readonly kind: 'extension' | 'task'; readonly reference: string | undefined },
    requester: TurnRequester = { kind: 'self' },
  ): Promise<JsonValue> {
    const runtime = this.#runtime
    const agent = runtime.repository.getAgent(agentId)?.revision.capabilities
    const credentialName = (id: CredentialId) => runtime.credentialLibrary.get(id)?.name
    const actor = {
      kind: 'agent' as const,
      agentId,
      requester: requester.kind === 'admin' ? ('admin' as const) : ('member' as const),
    }
    const authority = (actions: readonly ExtensionAction[], configure?: JsonValue) => ({
      autonomy: agent?.extensionAutonomy ?? 'manual',
      requesters: agent?.extensionRequesters ?? 'everyone',
      configRequesters: agent?.extensionConfigRequesters ?? 'admins',
      requestedBy: requester.kind === 'admin' ? 'admin' : 'member',
      actions: Object.fromEntries(
        actions.map((action) => [action.kind, runtime.extensionActions.assess(action, actor).decision]),
      ),
      ...(configure === undefined ? {} : { configure }),
      meaning:
        'run 由你直接完成（configure 在这次回复结束后生效），request 在频道里请管理员确认，console 需要管理员在后台处理。configure 按配置层和字段级别列出，按这次是谁提出的请求判断。',
    })
    if (target.kind === 'task') {
      const task = this.resolveTask(agentId, target.reference)
      const candidate = await runtime.authoringTestConfig.candidate(task.id)
      const fields = candidateConfigFields(candidate?.config)
      const test = runtime.authoringTestConfig.values(task.id)
      const defaults = Object.fromEntries(
        fields.flatMap((field) => (field.default === undefined ? [] : [[field.key, field.default] as const])),
      )
      const effective = { ...defaults, ...test.agentProvided, ...test.userEntered }
      const source = (key: string) =>
        test.userEntered[key] !== undefined ? 'user' : test.agentProvided[key] !== undefined ? 'agent' : 'default'
      return {
        task: { id: task.id, title: task.title, kind: task.kind, status: task.status },
        config: fields.map((field) => {
          const described = describeField(field, candidate?.permissions ?? {}, { values: effective }, credentialName)
          return field.kind === 'secret' || effective[field.key] === undefined
            ? described
            : { ...described, source: source(field.key) }
        }),
        problems: (['host', 'agent'] as const).flatMap((layer) =>
          layerProblems(fields, layer, effective, layer === 'host' ? '本机配置' : '智能体配置'),
        ),
        recentLogs: await this.#recentLogs({ kind: 'system', id: `preview:authoring-${task.episodeId}` }, agentId),
        authority: authority([{ kind: 'save', taskId: task.id }]),
      }
    }
    if (target.reference === undefined) throw new Error('请写上扩展名称或编号。')
    const extension = this.resolveExtension(agentId, target.reference)
    const installedRevision = runtime.repository.getHostInstallation(extension.id)?.extensionRevisionId
    const revision = runtime.repository.getExtensionRevision(this.currentRevision(extension.id))
    const manifest = revision === undefined ? undefined : runtime.extensionService.revisionManifest(revision)
    const fields = candidateConfigFields(manifest?.config)
    const versions = extensionVersions(runtime.repository, runtime.extensionService, extension.id)
    const hostValues = asRecord(runtime.repository.getHostInstallation(extension.id)?.config)
    // Only this agent's own activation: other agents' configuration stays theirs.
    const activation = runtime.repository.getActivation(agentId, extension.id)
    const agentValues = asRecord(activation?.config)
    const enablement =
      activation === undefined
        ? [
            runtime.extensionActions.enablementProblem(agentId, extension.id),
            runtime.extensionActions.enablementMissing(agentId, extension.id),
            runtime.extensionActions.enablementNote(agentId, extension.id),
          ].flatMap((line) => (line === undefined ? [] : [line]))
        : []
    return {
      extension: {
        id: extension.id,
        name: extension.displayName,
        createdByYou: extension.createdByAgentId === agentId,
      },
      config: fields.map((field) =>
        describeField(
          field,
          manifest?.permissions ?? {},
          field.layer === 'host'
            ? { values: hostValues }
            : activation === undefined
              ? undefined
              : { values: agentValues },
          credentialName,
        ),
      ),
      ...(activation === undefined && fields.some((field) => field.layer === 'agent')
        ? { agentConfigNote: '还没有给你启用，智能体配置在启用后才有值。' }
        : {}),
      problems: [
        ...layerProblems(fields, 'host', hostValues, '本机配置'),
        ...(activation === undefined ? [] : layerProblems(fields, 'agent', agentValues, '你的配置')),
        ...enablement,
      ],
      runtime: {
        installedVersion: installedRevision === undefined ? null : (versions.get(installedRevision)?.label ?? null),
        enabledFor: runtime.repository
          .listActivations()
          .filter((candidate) => candidate.extensionId === extension.id)
          .map((candidate) =>
            candidate.agentId === agentId
              ? '你'
              : (runtime.repository.getAgent(candidate.agentId)?.revision.displayName ?? '智能体'),
          ),
        recentLogs: await this.#recentLogs({ kind: 'extension', id: extension.id }, agentId),
      },
      configHistory: [
        ...runtime.extensionConfig.versions({ extensionId: extension.id, layer: 'host' }).slice(0, INSPECT_HISTORY),
        ...(activation === undefined
          ? []
          : runtime.extensionConfig
              .versions({ extensionId: extension.id, layer: 'agent', agentId })
              .slice(0, INSPECT_HISTORY)),
      ].map((record) => ({
        layer: record.layer,
        version: record.version,
        source: record.source,
        time: record.createdAt,
        ...(record.reason === null ? {} : { reason: record.reason }),
      })),
      authority: authority(
        [
          { kind: 'enable', extensionId: extension.id, agentId },
          { kind: 'disable', extensionId: extension.id, agentId },
          { kind: 'revert', extensionId: extension.id },
          {
            kind: 'branch',
            revisionId: this.currentRevision(extension.id),
            name: extension.displayName,
            copyData: false,
          },
          { kind: 'community-publish', extensionId: extension.id, notes: '' },
          { kind: 'community-update', extensionId: extension.id },
        ],
        this.#configureAuthority(fields, manifest?.permissions ?? {}, actor),
      ),
    }
  }

  /**
   * What configure would do for a field of each level present in each layer, judged like a real change; a credential
   * field counts as bound to a credential you may use without asking.
   */
  #configureAuthority(
    fields: readonly CandidateConfigField[],
    permissions: NetworkDeclaration,
    actor: Extract<Parameters<NekroRuntime['extensionActions']['assess']>[1], { readonly kind: 'agent' }>,
  ): JsonValue {
    const result: Record<string, Record<string, string>> = {}
    for (const layer of ['host', 'agent'] as const) {
      const byLevel = new Map<ConfigFieldLevel, CandidateConfigField>()
      for (const field of fields.filter((entry) => entry.layer === layer)) {
        const level = configFieldLevel(field, networkFields(permissions, layer))
        if (!byLevel.has(level)) byLevel.set(level, field)
      }
      if (byLevel.size === 0) continue
      result[layer] = Object.fromEntries(
        [...byLevel].map(([level, field]) => [level, this.#configureDecision(layer, field, level, actor)]),
      )
    }
    return result
  }

  #configureDecision(
    layer: 'host' | 'agent',
    field: CandidateConfigField,
    level: ConfigFieldLevel,
    actor: Extract<Parameters<NekroRuntime['extensionActions']['assess']>[1], { readonly kind: 'agent' }>,
  ): string {
    return this.#runtime.extensionActions.configureDecision(layer, { field, level }, actor)
  }

  async setTestConfig(
    taskId: DynamicAuthoringTask['id'],
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<{ readonly notes: readonly string[] }> {
    const runtime = this.#runtime
    const task = runtime.repository.getAuthoringTask(taskId)
    if (task === undefined) throw new Error('创造任务不存在。')
    const notes: string[] = []
    await runtime.authoringTestConfig.setAgentValues(taskId, values, (key, name) => {
      const credential = this.#testCredential(task.agentId, name)
      if (!runtime.credentialLibrary.needsApproval(credential, task.agentId)) {
        return namedCredentialReference(credential.id)
      }
      const actor = { kind: 'agent' as const, agentId: task.agentId, channelId: task.channelId }
      const action: ExtensionAction = {
        kind: 'use-credential',
        credentialId: credential.id,
        agentId: task.agentId,
        taskId,
        key,
      }
      const record = runtime.extensionRequests.create({
        action,
        actor,
        assessment: runtime.extensionActions.assess(action, actor),
      })
      notes.push(
        `凭据「${credential.name}」要管理员同意后才能用，已在频道里发出请求 #${record.number}；同意后会通知你，在那之前「${key}」保持原样。`,
      )
      return undefined
    })
    return { notes }
  }

  checkTestCredentials(agentId: AgentId, values: Readonly<Record<string, JsonValue>>): readonly string[] {
    return Object.values(values).flatMap((value) => {
      const name = testCredentialBinding(value)
      if (name === undefined) return []
      const credential = this.#testCredential(agentId, name)
      return this.#runtime.credentialLibrary.needsApproval(credential, agentId)
        ? [`凭据「${credential.name}」要管理员同意后才能用，记录候选后会在频道里发出请求。`]
        : []
    })
  }

  /** A credential the agent may bind by name; a clear error tells it what to do otherwise. */
  #testCredential(agentId: AgentId, name: string) {
    const library = this.#runtime.credentialLibrary
    const credential = library.find(name)
    if (credential === undefined) {
      throw new Error(
        `没有名为「${name}」的凭据。用 nekro_nxt_credential_list 查看可用的凭据，缺少时用 nekro_nxt_credential_request 请管理员添加。`,
      )
    }
    if (!library.inScope(credential, agentId)) throw new Error(`凭据「${credential.name}」不对你开放。`)
    return credential
  }

  async listCredentials(agentId: AgentId): Promise<JsonValue> {
    const runtime = this.#runtime
    const library = runtime.credentialLibrary
    const providers = (await modelProviderAccessList(runtime)).filter((provider) => provider.open)
    let models: readonly { readonly provider: string; readonly name: string }[] = []
    try {
      models = await runtime.host.listAvailableLlmModels()
    } catch {
      // Hosts without model settings list no models.
    }
    return {
      credentials: library.list().map((record) => {
        const envName = commandEnvName(record)
        return {
          name: record.name,
          ...(record.description === '' ? {} : { description: record.description }),
          kind: record.kind,
          usage: record.usage,
          domains: [...record.domains],
          autoUse: record.autoUse,
          ...(envName === undefined ? {} : { envName }),
          availableToYou: library.inScope(record, agentId) && library.available(record.id),
          needsApproval: library.inScope(record, agentId) && library.needsApproval(record, agentId),
        }
      }),
      modelProviders: providers.map((provider) => ({
        name: provider.name,
        models: models.filter((model) => model.provider === provider.provider).map((model) => model.name),
      })),
      meaning:
        'usage 为 request 的凭据只能在扩展里用 secrets.placeholder 放进 http.fetch 请求，发往 domains 中的域名；program 的凭据代码能读到值，带 envName 的会以这个环境变量交给你的命令。needsApproval 为 true 的要先用 nekro_nxt_credential_request 请管理员同意。modelProviders 是扩展通过 nxt.models 可以调用的模型。',
    }
  }

  requestCredential(
    agentId: AgentId,
    channelId: ChannelId,
    input: {
      readonly name: string
      readonly purpose: string
      readonly domains: readonly string[]
      readonly usage: CredentialUsage
    },
  ): JsonValue {
    const runtime = this.#runtime
    const library = runtime.credentialLibrary
    const existing = library.find(input.name)
    if (existing !== undefined && !library.inScope(existing, agentId)) {
      return {
        requested: false,
        message: `已经有凭据「${existing.name}」，但它不对你开放；请管理员在设置的「凭据」里把你加进可用范围。`,
      }
    }
    if (existing !== undefined && !library.needsApproval(existing, agentId)) {
      return { requested: false, message: `已经有凭据「${existing.name}」，可以直接使用。` }
    }
    if (existing !== undefined) {
      // It exists but its automatic use is off: ask to use it.
      const actor = { kind: 'agent' as const, agentId, channelId }
      const action: ExtensionAction = { kind: 'use-credential', credentialId: existing.id, agentId }
      const record = runtime.extensionRequests.create({
        action,
        actor,
        assessment: runtime.extensionActions.assess(action, actor),
      })
      return {
        requested: true,
        requestNumber: record.number,
        message: `凭据「${existing.name}」要管理员同意后才能用，已在频道里发出请求 #${record.number}，同意后会通知你。`,
      }
    }
    const { request, repeated } = runtime.credentialRequests.create({ agentId, channelId, ...input })
    return {
      requested: true,
      message: repeated
        ? `之前已经请管理员添加凭据「${request.name}」，还在等待；添加后会通知你。`
        : `已请管理员添加凭据「${request.name}」，添加后会通知你。在那之前告诉用户在等什么，不要让人把凭据发在聊天里。`,
    }
  }

  /**
   * The latest warnings and errors of one log source, redacted again before the agent sees them. Lines that belong to
   * another agent's runs are left out.
   */
  async #recentLogs(source: { readonly kind: 'extension' | 'system'; readonly id: string }, agentId: AgentId) {
    const logs = this.#runtime.logs
    if (logs === undefined) return []
    const page = await logs.query({ sources: [source], levels: ['warn', 'error'], limit: 50 })
    return page.entries
      .filter((entry) => entry.scope?.agentId === undefined || entry.scope.agentId === agentId)
      .slice(-INSPECT_LOG_LIMIT)
      .map((entry) => ({ time: entry.timestamp, level: entry.level, message: redactLogText(entry.message) }))
  }

  async #definition(extension: LocalExtension, revision: Revision): Promise<RevisionDefinition> {
    const content = await this.#runtime.extensionService.readRevisionContent(revision)
    const manifest = content.manifest
    const editable = editableRevisionSources({
      sources: content.sources,
      ...(manifest.clientCss === undefined ? {} : { clientCssPath: manifest.clientCss.path }),
    })
    const tools: Record<string, Readonly<Record<string, JsonValue>>> = {}
    const rpc: Record<string, JsonValue> = {}
    for (const contribution of manifest.contributions) {
      if (contribution.kind === 'tool' && contribution.verificationInput !== undefined) {
        tools[contribution.name] = contribution.verificationInput
      }
      if (contribution.kind === 'rpc' && contribution.verificationInput !== undefined) {
        rpc[contribution.method] = contribution.verificationInput
      }
    }
    const declared = manifest.contributions.filter(
      (contribution) => contribution.kind === 'host-page' || contribution.kind === 'command',
    )
    return {
      codeFormat: editable.format,
      snapshot: {
        name: extension.displayName,
        purpose: extension.description.trim() || extension.displayName,
        code: {
          ...(editable.host === undefined ? {} : { host: editable.host }),
          ...(editable.client === undefined ? {} : { client: editable.client }),
        },
        resources: content.resources,
        ...(manifest.clientCss === undefined ? {} : { clientCss: manifest.clientCss }),
        ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
        permissions: manifest.permissions,
        contributions: declared.map((contribution) => parseJsonValue(JSON.parse(JSON.stringify(contribution)))),
        ...(manifest.config === undefined ? {} : { config: manifest.config }),
        ...(Object.keys(tools).length + Object.keys(rpc).length === 0 ? {} : { verificationInputs: { tools, rpc } }),
        ...(manifest.dataVersion === undefined ? {} : { dataVersion: manifest.dataVersion }),
        ...(editable.format === 'module' ? { codeFormat: 'module' as const } : {}),
      },
    }
  }
}
