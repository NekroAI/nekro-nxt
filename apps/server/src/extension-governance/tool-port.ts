import {
  configSecretKeys,
  parseJsonValue,
  validateConfigValue,
  type AgentId,
  type ChannelId,
  type EpisodeId,
  type ExtensionId,
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
import { candidateConfigFields, type CandidateConfigField } from '../authoring-test-config.js'
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
   * Whether this agent's candidates run without anyone approving them: its extension autonomy is autonomous, or the
   * older automatic setting is on.
   */
  runsWithoutAsking(agentId: AgentId): boolean
  list(agentId: AgentId): JsonValue
  prepareRevise(
    agentId: AgentId,
    input: { readonly extension: string; readonly version?: string; readonly reference?: string },
  ): Promise<RevisePreparation>
  act(agentId: AgentId, channelId: ChannelId, action: ExtensionAction): Promise<ToolActionOutcome>
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
  ): Promise<JsonValue>
  /** Stores test values the agent provides for one of its tasks, checked against the task's latest candidate. */
  setTestConfig(taskId: DynamicAuthoringTask['id'], values: Readonly<Record<string, JsonValue>>): Promise<void>
}

type ConfigLayer = CandidateConfigField['layer']

/** Permissions as both a saved Manifest and a candidate declare them; only network config fields matter here. */
type NetworkLayer = { readonly network?: { readonly mode: string; readonly fields?: readonly string[] } | undefined }
interface NetworkDeclaration {
  readonly host?: NetworkLayer | undefined
  readonly agent?: NetworkLayer | undefined
}

const INSPECT_LOG_LIMIT = 5

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const networkFields = (permissions: NetworkDeclaration, layer: ConfigLayer): ReadonlySet<string> => {
  const network = permissions[layer]?.network
  return new Set(network?.mode === 'config' ? (network.fields ?? []) : [])
}

/**
 * One field as the agent sees it. `level` says how the value is handled: `secret` values are never shown, only whether
 * they are set; `network` values decide which addresses the extension may reach.
 */
const describeField = (
  field: CandidateConfigField,
  permissions: NetworkDeclaration,
  current: { readonly values: Readonly<Record<string, JsonValue>> } | undefined,
) => {
  const level =
    field.kind === 'secret' ? 'secret' : networkFields(permissions, field.layer).has(field.key) ? 'network' : 'normal'
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
      : level === 'secret'
        ? { set: typeof stored === 'string' && stored !== '' }
        : stored === undefined
          ? {}
          : { value: stored }),
  }
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
    const runtime = this.#runtime
    const agent = runtime.repository.getAgent(agentId)
    if (agent?.revision.capabilities.extensionRequesters !== 'admins') return { allowed: true as const }
    const episode = runtime.repository.getEpisode(episodeId)
    const eventId = episode?.lastAdmittedEventId ?? episode?.openedAtEventId
    const event = eventId === undefined ? undefined : runtime.repository.getChannelEvent(eventId)
    const channel = episode === undefined ? undefined : runtime.repository.getChannel(episode.channelId)
    // The built-in channel and the console speak for an administrator.
    if (
      channel?.kind === 'internal' ||
      event?.facts?.['consoleAnchor'] === true ||
      event?.senderMemberId === undefined
    ) {
      return { allowed: true as const }
    }
    const identity =
      channel === undefined
        ? undefined
        : runtime.core.resolveChannelMemberIdentity(channel.connectionId, channel.id, event.senderMemberId)
    return runtime.administrators.isAdministrator(channel?.connectionId, identity?.platformUserId)
      ? { allowed: true as const }
      : {
          allowed: false as const,
          reason: '这个智能体只接受 NekroNXT 管理员提出的扩展制作和修改；请礼貌地告诉对方需要管理员来提。',
        }
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
        const note = runtime.extensionActions.enablementNote(agentId, extension.id)
        return {
          id: extension.id,
          name: extension.displayName,
          slug: extension.slug,
          createdByYou: extension.createdByAgentId === agentId,
          enabledForYou: runtime.repository.getActivation(agentId, extension.id) !== undefined,
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

  async act(agentId: AgentId, channelId: ChannelId, action: ExtensionAction): Promise<ToolActionOutcome> {
    const runtime = this.#runtime
    const actor = { kind: 'agent' as const, agentId, channelId }
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
  ): Promise<JsonValue> {
    const runtime = this.#runtime
    const agent = runtime.repository.getAgent(agentId)?.revision.capabilities
    const authority = (actions: readonly ExtensionAction[]) => ({
      autonomy: agent?.extensionAutonomy ?? 'manual',
      requesters: agent?.extensionRequesters ?? 'everyone',
      actions: Object.fromEntries(
        actions.map((action) => [
          action.kind,
          runtime.extensionActions.assess(action, { kind: 'agent', agentId }).decision,
        ]),
      ),
      meaning: 'run 由你直接完成，request 在频道里请管理员确认，console 需要管理员在后台处理。',
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
          const described = describeField(field, candidate?.permissions ?? {}, { values: effective })
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
      authority: authority([
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
      ]),
    }
  }

  setTestConfig(taskId: DynamicAuthoringTask['id'], values: Readonly<Record<string, JsonValue>>): Promise<void> {
    return this.#runtime.authoringTestConfig.setAgentValues(taskId, values)
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
