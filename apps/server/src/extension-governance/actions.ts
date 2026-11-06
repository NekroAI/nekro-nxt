import {
  AgentIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  ChannelIdSchema,
  CommunityListingInputSchema,
  CommunityPermissionItemSchema,
  CommunityReviewStatusSchema,
  communityPublisherLabel,
  CredentialIdSchema,
  CredentialNameSchema,
  configFields,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  JsonValueSchema,
  type AgentId,
  type AuthoringAttemptId,
  type ChannelId,
  type CommunityPermissionItem,
  type ConfigField,
  type ExtensionConfigLayer,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import {
  ExtensionDataDowngradeError,
  addedPermissionItems,
  carryExtensionConfig,
  hasAgentLayer,
  highestPermissionLevel,
  layerConfigSchema,
  parseExtensionImport,
  type ExtensionManifest,
  summarizePermissions,
  type PermissionItem,
  type PermissionLevel,
  type Revision,
} from '@nekro-nxt/extension-runtime'
import type { NekroRuntime } from '../bootstrap.js'
import { CommunityError } from '../community.js'
import { REVIEW_STATUS_LABEL } from '../community-agent-tools.js'
import { DEEPSEEK_HARNESS_VERSION } from '../dsh-version.js'
import { createExtensionRevisionExport } from '../host-route-support.js'
import { ExtensionConfigMigration } from './config-migration.js'
import { namedCredentialReference } from '../credentials-library.js'
import { extensionVersions } from './versions.js'
import type { CredentialRecord } from '@nekro-nxt/storage-sqlite'
import {
  leveledConfigFields,
  type ExtensionConfigChange,
  type ExtensionConfigOwner,
  type ExtensionConfigWriteMeta,
  type LeveledConfigField,
} from './config-service.js'

/** Who asks for an extension action. Console and administrators act for themselves; agents are bound by autonomy. */
export type ExtensionActor =
  | { readonly kind: 'console' }
  | { readonly kind: 'administrator'; readonly label: string }
  | {
      readonly kind: 'agent'
      readonly agentId: AgentId
      readonly channelId?: ChannelId
      /**
       * Who asked the agent in this turn: an administrator, or a member (also when the agent acts on its own).
       * Configuration changes depend on it; absent counts as a member.
       */
      readonly requester?: 'admin' | 'member'
    }

/** Non-secret values by field; `null` puts a field back to its default. */
const ConfigValuesSchema = z.record(z.string().min(1).max(64), JsonValueSchema)
/** Secret fields bound to a named credential by name; `null` clears the field. */
const ConfigCredentialsSchema = z.record(z.string().min(1).max(64), CredentialNameSchema.nullable())
/** Who a configuration change comes from, recorded with the version it writes. */
const ConfigOrigin = {
  /** The agent that asked for the change. */
  actorAgentId: AgentIdSchema.optional(),
  /** The channel member whose message led to it. */
  requesterMemberId: z.string().min(1).max(128).optional(),
  reason: z.string().max(500).optional(),
}

/**
 * Every lifecycle step an agent, a chat command or the console can ask for; one implementation serves all three.
 * Requests store the action as JSON and read it back through this schema.
 */
export const ExtensionActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('save'),
    taskId: AuthoringTaskIdSchema,
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    /**
     * Also enables the saved extension for this agent, with starting configuration for both layers; one approval
     * covers both steps. The host pins the candidate (`attemptId`), so the approval saves what was asked about.
     */
    enable: z
      .object({
        agentId: AgentIdSchema,
        values: ConfigValuesSchema.optional(),
        credentials: ConfigCredentialsSchema.optional(),
        attemptId: AuthoringAttemptIdSchema.optional(),
        ...ConfigOrigin,
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('enable'),
    extensionId: ExtensionIdSchema,
    agentId: AgentIdSchema,
    /** Initial agent configuration, judged together with enabling. */
    values: ConfigValuesSchema.optional(),
    credentials: ConfigCredentialsSchema.optional(),
    ...ConfigOrigin,
  }),
  z.object({ kind: z.literal('disable'), extensionId: ExtensionIdSchema, agentId: AgentIdSchema }),
  /** Changes the extension's information: its name and description; leaving one out keeps it. */
  z.object({
    kind: z.literal('edit-info'),
    extensionId: ExtensionIdSchema,
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal('switch'), extensionId: ExtensionIdSchema, revisionId: ExtensionRevisionIdSchema }),
  z.object({ kind: z.literal('revert'), extensionId: ExtensionIdSchema }),
  z.object({
    kind: z.literal('branch'),
    revisionId: ExtensionRevisionIdSchema,
    name: z.string(),
    slug: z.string().optional(),
    copyData: z.boolean(),
  }),
  z.object({
    kind: z.literal('migrate-data'),
    targetExtensionId: ExtensionIdSchema,
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('extension'), extensionId: ExtensionIdSchema }),
      z.object({ kind: z.literal('snapshot'), snapshotId: z.string() }),
    ]),
    mode: z.enum(['overwrite', 'replace']),
    /** Also move the host and agent configuration; credentials never move. */
    includeConfig: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('community-publish'),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema.optional(),
    notes: z.string(),
    /** The community page's information to set with this release; fields left out stay as they are. */
    listing: CommunityListingInputSchema.optional(),
  }),
  z.object({ kind: z.literal('community-update'), extensionId: ExtensionIdSchema }),
  z.object({
    kind: z.literal('community-install'),
    communityExtensionId: z.string(),
    agentId: AgentIdSchema.optional(),
    /**
     * The release an agent asked for, as the community described it then. The host fills it in, never the agent, and
     * the approval installs exactly this release, so what the administrator read is what runs.
     */
    release: z
      .object({
        id: z.string(),
        number: z.number().int().positive().optional(),
        displayName: z.string(),
        publisherHandle: z.string(),
        permissions: z.array(CommunityPermissionItemSchema),
        reviewStatus: CommunityReviewStatusSchema,
        ratingScore: z.number().nullable(),
      })
      .optional(),
    /** Why the agent wants it, shown to the administrator. */
    reason: z.string().max(500).optional(),
  }),
  z.object({ kind: z.literal('community-withdraw'), releaseId: z.string() }),
  /**
   * Lets an agent use a named credential whose automatic use is off (智能体扩展配置与凭据 C3): the approval stays on the
   * credential. With a task and a field, that field of the task's test configuration is bound to it as well.
   */
  /**
   * Changes one layer of an extension's configuration (智能体扩展配置与凭据 C10). The agent layer names the agent;
   * the host layer is shared by every agent.
   */
  z.object({
    kind: z.literal('configure'),
    extensionId: ExtensionIdSchema,
    layer: z.enum(['host', 'agent']),
    agentId: AgentIdSchema.optional(),
    values: ConfigValuesSchema.default({}),
    credentials: ConfigCredentialsSchema.default({}),
    ...ConfigOrigin,
  }),
  /** Writes an earlier configuration version again (C12). */
  z.object({
    kind: z.literal('revert-config'),
    extensionId: ExtensionIdSchema,
    versionId: z.number().int().positive(),
    ...ConfigOrigin,
  }),
  z.object({
    kind: z.literal('use-credential'),
    credentialId: CredentialIdSchema,
    agentId: AgentIdSchema,
    taskId: AuthoringTaskIdSchema.optional(),
    key: z.string().optional(),
  }),
  /**
   * Restarts NekroNXT (#123). Not extension work, but it shares the request flow: an agent can only ask, and the
   * approval announces the restart in the channel the request came from, which the host fills in.
   */
  z.object({
    kind: z.literal('restart-host'),
    reason: z.string().min(1).max(500),
    channelId: ChannelIdSchema.optional(),
  }),
])
export type ExtensionAction = z.output<typeof ExtensionActionSchema>

/**
 * What an actor may do about an action right now: `run` it, `request` an administrator's confirmation, or do it in
 * the `console` only.
 */
export interface ExtensionActionAssessment {
  readonly decision: 'run' | 'request' | 'console'
  /** Why it is not `run`; shown to the agent and in the request. */
  readonly reason?: string
  /** One line naming what will happen, used in requests and receipts. */
  readonly summary: string
  readonly level: PermissionLevel
  /** Permission items the action grants that are not granted yet. */
  readonly added: readonly (PermissionItem | CommunityPermissionItem)[]
}

export interface ExtensionActionResult {
  readonly message: string
  readonly extensionId?: ExtensionId
  readonly revisionId?: ExtensionRevisionId
  /** Community release a publish created; its review result is reported back to the channel later. */
  readonly releaseId?: string
  /** The extension's public community page, which anyone can open without signing in. */
  readonly pageUrl?: string
}

const OUTWARD: readonly ExtensionAction['kind'][] = ['community-publish', 'community-withdraw']

/** A configuration change checked against the schema, with the named credentials it binds. */
export interface ConfigPlan {
  readonly owner: ExtensionConfigOwner
  readonly change: ExtensionConfigChange
  readonly credentials: readonly { readonly key: string; readonly record: CredentialRecord }[]
}

type EnableAction = Extract<ExtensionAction, { readonly kind: 'enable' }>
type SaveAction = Extract<ExtensionAction, { readonly kind: 'save' }>
type Verdict = Pick<ExtensionActionAssessment, 'decision' | 'reason'>

/** The configuration `enable` writes, split by layer; `agentGiven` tells whether any of it was for the agent's layer. */
interface EnablePlans {
  readonly agent: ConfigPlan
  readonly agentGiven: boolean
  readonly host?: ConfigPlan
}

/** The candidate a save that also enables is judged on, read before the extension exists. */
interface SaveCandidate {
  readonly items: readonly PermissionItem[]
  readonly fields: Readonly<Record<ExtensionConfigLayer, readonly LeveledConfigField[]>>
}

/** One field a configuration change at enabling touches, as the approval names it; values are never shown. */
interface ConfigMention {
  readonly layer: ExtensionConfigLayer
  readonly field: ConfigField
  /** The credential a secret field is bound to, `null` when cleared, `undefined` for a plain value. */
  readonly credential?: string | null
}

const STRICTNESS = { run: 0, request: 1, console: 2 } as const

/** The strictest of several decisions with every reason behind it; `run` when there are none. */
const strictest = (verdicts: readonly Verdict[]): Verdict => {
  const decision = verdicts.reduce<Verdict['decision']>(
    (strict, verdict) => (STRICTNESS[verdict.decision] > STRICTNESS[strict] ? verdict.decision : strict),
    'run',
  )
  const reasons = [
    ...new Set(
      verdicts.flatMap((verdict) => (verdict.decision === decision && verdict.reason ? [verdict.reason] : [])),
    ),
  ]
  return reasons.length === 0 ? { decision } : { decision, reason: reasons.join('') }
}

const CANDIDATE_CHANGED = '候选在发出请求之后换过了，这次没有保存。请用新的候选重新保存。'

const LAYER_NAME: Readonly<Record<ExtensionConfigLayer, string>> = { host: '本机配置', agent: '智能体配置' }

/** The next step when host configuration is asked for before the extension is installed. */
export const HOST_CONFIG_AT_ENABLE =
  '本机配置可以在启用时一起设置：enable 的 values 或 credentials 里直接写本机配置的字段；还没保存的候选用 save 加 enable: true，保存后一起启用。'

/** What enabling writes into configuration, for the approval: fields by layer and credential names, never values. */
const configMentions = (mentions: readonly ConfigMention[]): string =>
  (['host', 'agent'] as const)
    .flatMap((layer) => {
      const own = mentions.filter((mention) => mention.layer === layer)
      if (own.length === 0) return []
      const parts = [
        ...own.flatMap((mention) =>
          typeof mention.credential === 'string'
            ? [`「${mention.field.title}」绑定凭据「${mention.credential}」`]
            : mention.credential === null
              ? [`「${mention.field.title}」解除绑定`]
              : [],
        ),
        ...(own.some((mention) => mention.credential === undefined)
          ? [
              `填写${own
                .filter((mention) => mention.credential === undefined)
                .map((mention) => `「${mention.field.title}」`)
                .join('')}`,
            ]
          : []),
      ]
      return [`${LAYER_NAME[layer]}${parts.join('、')}`]
    })
    .map((part) => `，${part}`)
    .join('')

const slugFrom = (name: string, fallback: string): string => {
  const ascii = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return ascii.length >= 3 ? ascii.slice(0, 48) : `${fallback}-${Date.now().toString(36)}`
}

/**
 * Extension lifecycle actions behind the workshop, the `/ext` commands and the agent's extension tools. It decides
 * whether the actor may act (agents follow their autonomy level and the permission risk), and performs the action
 * with the approvals the decision implies.
 */
export class ExtensionActionService {
  readonly #runtime: NekroRuntime
  /** Candidates of pending saves that also enable, by attempt; read by `prepare` because reading them is async. */
  readonly #candidates = new Map<AuthoringAttemptId, SaveCandidate>()

  constructor(runtime: NekroRuntime) {
    this.#runtime = runtime
  }

  // —— Assessment ——

  assess(action: ExtensionAction, actor: ExtensionActor): ExtensionActionAssessment {
    const { summary, level, added, affectsOthers } = this.#describe(action, actor)
    const base = { summary, level, added }
    if (actor.kind === 'console') return { ...base, decision: 'run' }
    if (action.kind === 'configure' || action.kind === 'revert-config') {
      let plan: ConfigPlan
      try {
        plan = this.configPlan(action)
      } catch (error) {
        return { ...base, decision: 'console', reason: error instanceof Error ? error.message : String(error) }
      }
      if (actor.kind === 'agent') {
        const scope = this.#agentScope(action, actor.agentId)
        if (scope !== undefined) return { ...base, decision: 'console', reason: scope }
      }
      return { ...base, ...this.#configVerdict(plan, actor) }
    }
    // Using a credential is not extension work: every autonomy level may ask, and only the credential needs a yes.
    if (action.kind === 'use-credential') {
      if (actor.kind === 'administrator') return { ...base, decision: 'run' }
      const scope = this.#agentScope(action, actor.agentId)
      if (scope !== undefined) return { ...base, decision: 'console', reason: scope }
      return { ...base, decision: 'request', reason: '这个凭据需要管理员同意后才能使用。' }
    }
    // Whatever its autonomy, an agent only asks; an administrator's approval runs it.
    if (action.kind === 'restart-host') {
      return actor.kind === 'agent'
        ? { ...base, decision: 'request', reason: '重启需要管理员同意。' }
        : { ...base, decision: 'run' }
    }
    const initial =
      action.kind === 'enable'
        ? this.#initialConfigVerdict(action, actor)
        : action.kind === 'save' && action.enable !== undefined
          ? this.#saveEnableVerdict(action, actor)
          : undefined
    if (initial?.decision === 'console') return { ...base, ...initial }
    if (actor.kind === 'administrator') {
      return level === 'high'
        ? { ...base, decision: 'console', reason: '涉及高风险权限，需要在 NekroNXT 后台确认。' }
        : { ...base, decision: 'run' }
    }
    const agent = this.#runtime.repository.getAgent(actor.agentId)
    const autonomy = agent?.revision.capabilities.extensionAutonomy ?? 'manual'
    if (autonomy === 'manual') {
      return { ...base, decision: 'console', reason: '这个智能体的扩展自主权是「手动」，需要在工坊里操作。' }
    }
    const scope = this.#agentScope(action, actor.agentId)
    if (scope !== undefined) return { ...base, decision: 'console', reason: scope }
    if (action.kind === 'enable') {
      const problem = this.enablementProblem(action.agentId, action.extensionId, this.#hostBound(action))
      if (problem !== undefined) return { ...base, decision: 'console', reason: problem }
    }
    if (level === 'high') {
      return { ...base, decision: 'console', reason: '涉及高风险权限，需要在 NekroNXT 后台确认。' }
    }
    if (OUTWARD.includes(action.kind)) {
      return { ...base, decision: 'request', reason: '会在社区公开，需要管理员确认。' }
    }
    if (action.kind === 'community-install') {
      return { ...base, decision: 'request', reason: '社区扩展的代码会在这台机器上运行，需要管理员确认。' }
    }
    if (action.kind === 'branch' && action.copyData) {
      return { ...base, decision: 'request', reason: '会复制扩展数据，需要管理员确认。' }
    }
    if (action.kind === 'migrate-data') {
      return { ...base, decision: 'request', reason: '会改写已有数据，需要管理员确认。' }
    }
    if (affectsOthers) return { ...base, decision: 'request', reason: '会影响其他智能体，需要管理员确认。' }
    if (autonomy === 'confirm') return { ...base, decision: 'request', reason: '需要管理员确认。' }
    if (level === 'elevated') {
      return { ...base, decision: 'request', reason: '需要提升级权限，需要管理员确认。' }
    }
    if (initial !== undefined) return { ...base, ...initial }
    return { ...base, decision: 'run' }
  }

  /**
   * What a configuration change writes and which fields and credentials it touches; throws a message for the agent
   * when the change does not fit the schema or names a credential that does not exist.
   */
  configPlan(action: Extract<ExtensionAction, { readonly kind: 'configure' | 'revert-config' }>): ConfigPlan {
    const config = this.#runtime.extensionConfig
    if (action.kind === 'revert-config') {
      const record = config.version(action.versionId)
      if (record.extensionId !== action.extensionId) throw new Error('没有这个配置版本。')
      const owner: ExtensionConfigOwner = {
        extensionId: record.extensionId,
        layer: record.layer,
        ...(record.agentId === null ? {} : { agentId: record.agentId }),
      }
      const change = config.revertChange(record)
      return { owner, change: { ...change, changed: config.revertFields(record) }, credentials: [] }
    }
    if (action.layer === 'agent' && action.agentId === undefined) throw new Error('修改智能体配置要指明智能体。')
    const owner: ExtensionConfigOwner = {
      extensionId: action.extensionId,
      layer: action.layer,
      ...(action.layer === 'agent' ? { agentId: action.agentId } : {}),
    }
    const { ids, records } = this.#credentialIds(action.credentials)
    return { owner, change: config.planChange(owner, action.values, ids), credentials: records }
  }

  /** Configuration decisions by field level, layer, requester and credential (智能体扩展配置与凭据 C10、C11). */
  #configVerdict(
    plan: ConfigPlan,
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): Pick<ExtensionActionAssessment, 'decision' | 'reason'> {
    return this.#levelVerdict(
      {
        layer: plan.owner.layer,
        changed: plan.change.changed,
        bound: plan.credentials.filter(({ key }) => plan.change.bindings[key] !== null),
      },
      actor,
    )
  }

  /**
   * The decision for changing one field of `level` in `layer`; a secret field counts as bound to a credential the
   * agent may use without asking. Used to show the agent what configure would do.
   */
  configureDecision(
    layer: ExtensionConfigOwner['layer'],
    field: LeveledConfigField,
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): ExtensionActionAssessment['decision'] {
    return this.#levelVerdict({ layer, changed: [field], bound: [] }, actor).decision
  }

  #levelVerdict(
    input: {
      readonly layer: ExtensionConfigOwner['layer']
      readonly changed: readonly LeveledConfigField[]
      readonly bound: readonly { readonly key: string; readonly record: CredentialRecord }[]
    },
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): Pick<ExtensionActionAssessment, 'decision' | 'reason'> {
    const levels = new Set(input.changed.map((entry) => entry.level))
    const adminOnly = input.changed.filter((entry) => entry.level === 'admin')
    if (adminOnly.length > 0) {
      return {
        decision: 'console',
        reason: `「${adminOnly.map((entry) => entry.field.title).join('」「')}」只能由管理员在后台修改。`,
      }
    }
    if (actor.kind === 'administrator') return { decision: 'run' }
    const capabilities = this.#runtime.repository.getAgent(actor.agentId)?.revision.capabilities
    const bound = input.bound
    if (actor.requester !== 'admin') {
      if ((capabilities?.extensionConfigRequesters ?? 'admins') === 'admins') {
        return {
          decision: 'console',
          reason: '这个智能体只接受管理员提出的配置修改；请告诉对方需要管理员来提，或者由管理员在后台修改。',
        }
      }
      if (input.layer === 'host' || levels.has('network') || levels.has('secret')) {
        return {
          decision: 'console',
          reason: '本机配置、网络地址和凭据只接受管理员提出的修改；请告诉对方需要管理员来提。',
        }
      }
    }
    if ((capabilities?.extensionAutonomy ?? 'manual') === 'manual') {
      return { decision: 'console', reason: '这个智能体的扩展自主权是「手动」，需要在工坊里修改配置。' }
    }
    if (input.layer === 'host') {
      return { decision: 'request', reason: '本机配置由所有智能体共用，需要管理员确认。' }
    }
    if (levels.has('network')) {
      return { decision: 'request', reason: '会改变扩展可以访问的地址，需要管理员确认。' }
    }
    const library = this.#runtime.credentialLibrary
    for (const { record } of bound) {
      if (!library.inScope(record, actor.agentId)) {
        return { decision: 'console', reason: `凭据「${record.name}」不对你开放。` }
      }
    }
    const waiting = bound.filter(({ record }) => library.needsApproval(record, actor.agentId))
    if (waiting.length > 0) {
      return {
        decision: 'request',
        reason: `凭据「${waiting.map(({ record }) => record.name).join('」「')}」需要管理员同意后才能使用。`,
      }
    }
    if (capabilities?.extensionAutonomy === 'confirm') return { decision: 'request', reason: '需要管理员确认。' }
    return { decision: 'run' }
  }

  /**
   * Initial values given with `enable` are judged like changes to the layers that declare them, taking the stricter
   * decision; a credential bound into the host configuration must also be open to the agent.
   */
  #initialConfigVerdict(
    action: EnableAction,
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): Verdict | undefined {
    if (action.values === undefined && action.credentials === undefined) return undefined
    let plans: EnablePlans
    try {
      plans = this.#enablePlans(action)
    } catch (error) {
      return { decision: 'console', reason: error instanceof Error ? error.message : String(error) }
    }
    const verdicts = [
      ...(plans.host === undefined || plans.agentGiven ? [this.#configVerdict(plans.agent, actor)] : []),
      ...(plans.host === undefined
        ? []
        : [this.#configVerdict(plans.host, actor), this.#credentialVerdict(plans.host.credentials, actor)]),
    ]
    const verdict = strictest(verdicts)
    return verdict.decision === 'run' ? undefined : verdict
  }

  /**
   * Splits the values and credentials given with `enable` by the layer that declares each field: host fields become a
   * change to the shared host configuration, the rest the agent's starting configuration. `agentGiven` tells whether
   * any were for the agent's own layer. Throws a message for the agent on unknown fields or credentials.
   */
  #enablePlans(action: EnableAction): EnablePlans {
    const config = this.#runtime.extensionConfig
    const agentOwner: ExtensionConfigOwner = {
      extensionId: action.extensionId,
      layer: 'agent',
      agentId: action.agentId,
    }
    const manifest = config.manifest(agentOwner)
    const split = this.#splitByLayer(
      {
        host: leveledConfigFields(manifest, 'host'),
        agent: leveledConfigFields(manifest, 'agent'),
      },
      action.values ?? {},
      action.credentials ?? {},
    )
    const { ids, records } = this.#credentialIds(action.credentials ?? {})
    const pick = (keys: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(Object.entries(ids).filter(([key]) => Object.hasOwn(keys, key)))
    const agent: ConfigPlan = {
      owner: agentOwner,
      change: config.planChange(
        agentOwner,
        split.agent.values,
        pick(split.agent.credentials),
        this.#runtime.repository.getActivation(action.agentId, action.extensionId)?.config,
      ),
      credentials: records.filter(({ key }) => Object.hasOwn(split.agent.credentials, key)),
    }
    const agentGiven = Object.keys(split.agent.values).length + Object.keys(split.agent.credentials).length > 0
    const hostGiven = Object.keys(split.host.values).length + Object.keys(split.host.credentials).length > 0
    if (!hostGiven) return { agent, agentGiven }
    const hostOwner: ExtensionConfigOwner = { extensionId: action.extensionId, layer: 'host' }
    return {
      agent,
      agentGiven,
      host: {
        owner: hostOwner,
        change: config.planChange(hostOwner, split.host.values, pick(split.host.credentials)),
        credentials: records.filter(({ key }) => Object.hasOwn(split.host.credentials, key)),
      },
    }
  }

  /** Values and credentials sorted by the layer that declares each field; unknown fields are refused. */
  #splitByLayer<T, C>(
    fields: Readonly<Record<ExtensionConfigLayer, readonly LeveledConfigField[]>>,
    values: Readonly<Record<string, T>>,
    credentials: Readonly<Record<string, C>>,
  ): Record<ExtensionConfigLayer, { values: Record<string, T>; credentials: Record<string, C> }> {
    const layerOf = (key: string): ExtensionConfigLayer | undefined =>
      fields.agent.some((entry) => entry.field.key === key)
        ? 'agent'
        : fields.host.some((entry) => entry.field.key === key)
          ? 'host'
          : undefined
    const unknown = [...new Set([...Object.keys(values), ...Object.keys(credentials)])].filter(
      (key) => layerOf(key) === undefined,
    )
    if (unknown.length > 0) {
      throw new Error(
        `扩展的配置里没有这些字段：${unknown.join('、')}。用 nekro_nxt_extension_inspect 查看它有哪些配置项。`,
      )
    }
    const split = {
      host: { values: {} as Record<string, T>, credentials: {} as Record<string, C> },
      agent: { values: {} as Record<string, T>, credentials: {} as Record<string, C> },
    }
    for (const [key, value] of Object.entries(values)) split[layerOf(key)!].values[key] = value
    for (const [key, value] of Object.entries(credentials)) split[layerOf(key)!].credentials[key] = value
    return split
  }

  /** Host-layer secrets this `enable` binds, which no longer count as missing. */
  #hostBound(action: EnableAction): ReadonlySet<string> {
    if (action.values === undefined && action.credentials === undefined) return new Set()
    try {
      const host = this.#enablePlans(action).host
      return new Set(host?.credentials.map(({ key }) => key) ?? [])
    } catch {
      return new Set()
    }
  }

  /** Whether the agent may use the credentials bound: out of its scope is refused, automatic use off asks. */
  #credentialVerdict(
    bound: ConfigPlan['credentials'],
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): Verdict {
    if (actor.kind === 'administrator') return { decision: 'run' }
    const library = this.#runtime.credentialLibrary
    const closed = bound.filter(({ record }) => !library.inScope(record, actor.agentId))
    if (closed.length > 0) {
      return {
        decision: 'console',
        reason: `凭据「${closed.map(({ record }) => record.name).join('」「')}」不对你开放。`,
      }
    }
    const waiting = bound.filter(({ record }) => library.needsApproval(record, actor.agentId))
    return waiting.length === 0
      ? { decision: 'run' }
      : {
          decision: 'request',
          reason: `凭据「${waiting.map(({ record }) => record.name).join('」「')}」需要管理员同意后才能使用。`,
        }
  }

  /**
   * Reads what the host decides for a save that also enables: the candidate is pinned, and when no credentials are
   * given the trial run's named credential bindings carry over. Other actions come back unchanged. Call it before
   * `assess` for such a save; the candidate it reads is what the assessment counts permissions and fields from.
   */
  async prepare(action: ExtensionAction): Promise<ExtensionAction> {
    if (action.kind !== 'save' || action.enable === undefined) return action
    const runtime = this.#runtime
    const attempt = runtime.repository.listAuthoringAttempts(action.taskId).at(-1)
    if (attempt === undefined) throw new Error('这个任务还没有候选。')
    const pinned = action.enable.attemptId
    // A candidate replaced since the request was made is not judged; performing it is refused.
    if (pinned !== undefined && pinned !== attempt.id) return action
    const snapshot = await runtime.authoringTestConfig.candidate(action.taskId)
    if (snapshot === undefined) throw new Error('这个任务还没有候选。')
    const declaration = { permissions: snapshot.permissions, config: snapshot.config }
    this.#candidates.set(attempt.id, {
      items: summarizePermissions(declaration),
      fields: { host: leveledConfigFields(declaration, 'host'), agent: leveledConfigFields(declaration, 'agent') },
    })
    if (pinned !== undefined) return action
    let credentials = action.enable.credentials
    // An installed extension switches to the new version and keeps its configuration.
    if (credentials === undefined && this.#installedTarget(action) === undefined) {
      const bound = (await runtime.authoringTestConfig.describe(action.taskId)).boundCredentials
      const names = Object.entries(bound).flatMap(([key, id]) => {
        const record = runtime.credentialLibrary.get(id)
        return record === undefined ? [] : [[key, record.name] as const]
      })
      if (names.length > 0) credentials = Object.fromEntries(names)
    }
    // Read back through the schema, so the same request asked twice compares equal.
    return ExtensionActionSchema.parse({
      ...action,
      enable: { ...action.enable, ...(credentials === undefined ? {} : { credentials }), attemptId: attempt.id },
    })
  }

  /**
   * Why a save that also enables cannot do the enabling, judged on the candidate before anything is asked; undefined
   * when it can. Needs `prepare` first.
   */
  saveEnableProblem(action: ExtensionAction): string | undefined {
    if (action.kind !== 'save' || action.enable === undefined) return undefined
    const target = this.#installedTarget(action)
    if (target !== undefined && (action.enable.values !== undefined || action.enable.credentials !== undefined)) {
      return `「${this.#extensionName(target)}」已经安装在本机，保存并切换到新版本时沿用现在的配置；要改配置，切换后用 configure。`
    }
    const candidate = this.#saveCandidate(action)
    if (candidate === undefined) return CANDIDATE_CHANGED
    if (target !== undefined) return undefined
    const values = action.enable.values ?? {}
    try {
      this.#splitByLayer(candidate.fields, values, action.enable.credentials ?? {})
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    const missing = candidate.fields.agent.filter(({ field }) => {
      if (field.kind === 'secret' || !field.required || field.default !== undefined) return false
      const value = values[field.key]
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    })
    return missing.length === 0
      ? undefined
      : `启用前还要填写智能体配置：${missing.map(({ field }) => `「${field.title}」（${field.key}）`).join('、')}。在 values 里一起提供。`
  }

  /** The installed extension a save of a revise task makes a new version of; with `enable` it switches to it. */
  #installedTarget(action: SaveAction): ExtensionId | undefined {
    const task = this.#runtime.repository.getAuthoringTask(action.taskId)
    const target = task?.kind === 'revise' ? task.targetExtensionId : undefined
    return target !== undefined && this.#runtime.repository.getHostInstallation(target) !== undefined
      ? target
      : undefined
  }

  #saveCandidate(action: SaveAction): SaveCandidate | undefined {
    const attempt = this.#runtime.repository.listAuthoringAttempts(action.taskId).at(-1)
    const pinned = action.enable?.attemptId ?? attempt?.id
    return attempt === undefined || pinned !== attempt.id ? undefined : this.#candidates.get(attempt.id)
  }

  /**
   * A save that also enables, judged before the extension exists: the candidate's configuration fields as a change to
   * the layers that declare them, the credentials bound, and the candidate still being the one asked about.
   */
  #saveEnableVerdict(
    action: SaveAction,
    actor: Exclude<ExtensionActor, { readonly kind: 'console' }>,
  ): Verdict | undefined {
    const enable = action.enable
    if (enable === undefined) return undefined
    const candidate = this.#saveCandidate(action)
    if (candidate === undefined) return { decision: 'console', reason: CANDIDATE_CHANGED }
    if (enable.values === undefined && enable.credentials === undefined) return undefined
    if (this.#installedTarget(action) !== undefined) return undefined
    let split: Record<ExtensionConfigLayer, readonly LeveledConfigField[]>
    let records: ConfigPlan['credentials']
    try {
      split = this.#saveConfigFields(candidate, enable)
      records = this.#credentialIds(enable.credentials ?? {}).records
    } catch (error) {
      return { decision: 'console', reason: error instanceof Error ? error.message : String(error) }
    }
    const verdicts = (['agent', 'host'] as const).flatMap((layer) => {
      const changed = split[layer]
      if (changed.length === 0 && (layer === 'host' || split.host.length > 0)) return []
      const bound = records.filter(({ key }) => changed.some((entry) => entry.field.key === key))
      return [
        this.#levelVerdict({ layer, changed, bound }, actor),
        ...(layer === 'host' ? [this.#credentialVerdict(bound, actor)] : []),
      ]
    })
    const verdict = strictest(verdicts)
    return verdict.decision === 'run' ? undefined : verdict
  }

  /** The candidate's fields a save that also enables sets, by layer. */
  #saveConfigFields(
    candidate: SaveCandidate,
    enable: NonNullable<SaveAction['enable']>,
  ): Record<ExtensionConfigLayer, readonly LeveledConfigField[]> {
    const split = this.#splitByLayer(candidate.fields, enable.values ?? {}, enable.credentials ?? {})
    const touched = (layer: ExtensionConfigLayer) =>
      candidate.fields[layer].filter(
        ({ field }) =>
          Object.hasOwn(split[layer].values, field.key) || Object.hasOwn(split[layer].credentials, field.key),
      )
    return { host: touched('host'), agent: touched('agent') }
  }

  #credentialIds(credentials: Readonly<Record<string, string | null>>): {
    readonly ids: Readonly<Record<string, ExtensionConfigChange['bindings'][string]>>
    readonly records: readonly { readonly key: string; readonly record: CredentialRecord }[]
  } {
    const library = this.#runtime.credentialLibrary
    const ids: Record<string, ExtensionConfigChange['bindings'][string]> = {}
    const records: { key: string; record: CredentialRecord }[] = []
    for (const [key, name] of Object.entries(credentials)) {
      if (name === null) {
        ids[key] = null
        continue
      }
      const record = library.find(name)
      if (record === undefined) {
        throw new Error(
          `没有名为「${name}」的凭据。用 nekro_nxt_credential_list 查看可用的凭据，缺少时用 nekro_nxt_credential_request 请管理员添加。`,
        )
      }
      ids[key] = record.id
      records.push({ key, record })
    }
    return { ids, records }
  }

  /**
   * Why this agent cannot have the extension enabled yet, when only an administrator can fix it. Checks only shared
   * host configuration and this agent's own configuration, and never returns stored values. Required fields the agent
   * may fill itself are reported by `enablementMissing`; its own credentials never block enabling, see
   * `enablementNote`. Host secrets in `hostBound` are bound by the same enabling and do not count as missing.
   */
  enablementProblem(
    agentId: AgentId,
    extensionId: ExtensionId,
    hostBound: ReadonlySet<string> = new Set(),
  ): string | undefined {
    const runtime = this.#runtime
    const revision = this.#maybeCurrent(extensionId)
    if (!revision) return '这个扩展没有可用的版本，请管理员在工坊里检查。'
    const manifest = runtime.extensionService.revisionManifest(revision)
    if (!manifest) return '这个扩展的格式不受支持，请管理员在工坊里更新。'
    if (!hasAgentLayer(manifest)) return '这个扩展没有智能体能力，请管理员在工坊里安装到本机。'
    if (
      runtime.repository.getExtensionRevisionVerification(revision.id)?.contractVersion !== 'nekro-nxt-extension-v5'
    ) {
      return '这个扩展尚未完成本机验证，请管理员在工坊里检查验证结果。'
    }
    const host = this.#layerConfig(
      manifest,
      'host',
      runtime.repository.getHostInstallation(extensionId)?.config,
      hostBound,
    )
    if (host === undefined) return '本机配置不完整，请管理员在工坊的扩展详情里填写后重试。'
    if (host.missingSecrets) return '本机配置缺少必填凭据，请管理员在工坊的扩展详情里填写后重试。'
    const missing = this.#missingAgentFields(manifest, runtime.repository.getActivation(agentId, extensionId)?.config)
    const adminOnly = missing.filter((field) => field.adminOnly)
    if (adminOnly.length > 0) {
      return `智能体配置还缺只能由管理员填写的「${adminOnly.map((field) => field.title).join('」「')}」，需要管理员在工坊里处理。`
    }
    return undefined
  }

  /**
   * Required fields of the agent's own configuration still empty after defaults, the stored values and `values`:
   * the agent can pass them with `enable`. Undefined when nothing is missing.
   */
  enablementMissing(
    agentId: AgentId,
    extensionId: ExtensionId,
    values: Readonly<Record<string, JsonValue>> = {},
  ): string | undefined {
    const revision = this.#maybeCurrent(extensionId)
    const manifest = revision === undefined ? undefined : this.#runtime.extensionService.revisionManifest(revision)
    if (!manifest || !hasAgentLayer(manifest)) return undefined
    const stored = this.#runtime.repository.getActivation(agentId, extensionId)?.config
    const merged = {
      ...(stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
      ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
    }
    const missing = this.#missingAgentFields(manifest, merged).filter((field) => !field.adminOnly)
    return missing.length === 0
      ? undefined
      : `启用前还要填写智能体配置：${missing.map((field) => `「${field.title}」（${field.key}）`).join('、')}。启用时在 values 里一起提供。`
  }

  #missingAgentFields(manifest: ExtensionManifest, value: JsonValue | undefined) {
    const schema = layerConfigSchema(manifest, 'agent')
    const record =
      value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return configFields(schema).filter((field) => {
      if (field.kind === 'secret' || !field.required) return false
      const current = record[field.key] ?? field.default
      return current === undefined || current === null || (typeof current === 'string' && current.trim() === '')
    })
  }

  /**
   * What still needs doing after enabling: the agent's own credentials can only be filled once it is enabled, and
   * host credentials still unbound make the features that use them fail.
   */
  enablementNote(agentId: AgentId, extensionId: ExtensionId): string | undefined {
    const runtime = this.#runtime
    const revision = this.#maybeCurrent(extensionId)
    const manifest = revision === undefined ? undefined : runtime.extensionService.revisionManifest(revision)
    if (!manifest || !hasAgentLayer(manifest)) return undefined
    const asValues = (stored: JsonValue | undefined) =>
      stored !== null && stored !== undefined && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
    const record = asValues(runtime.repository.getActivation(agentId, extensionId)?.config)
    const host = asValues(runtime.repository.getHostInstallation(extensionId)?.config)
    const own = configFields(layerConfigSchema(manifest, 'agent')).some(
      (field) => field.kind === 'secret' && field.required && record[field.key] === undefined,
    )
    const shared = configFields(layerConfigSchema(manifest, 'host')).filter(
      (field) => field.kind === 'secret' && host[field.key] === undefined,
    )
    const notes = [
      own
        ? '启用后还缺你自己的凭据：有可用的凭据时用 configure 的 credentials 绑定，没有时请管理员添加；填好之前用到凭据的功能不能用。'
        : '',
      shared.length === 0
        ? ''
        : `本机配置的凭据${shared.map((field) => `「${field.title}」（${field.key}）`).join('、')}还没有绑定，用到它的功能会失败：还没启用时在 enable 的 credentials 里一起绑定，已经启用的用 configure（layer: host）绑定，都要管理员确认；没有合适的凭据时用 nekro_nxt_credential_request 请管理员添加。`,
    ].filter((note) => note !== '')
    return notes.length === 0 ? undefined : notes.join('')
  }

  /** A layer's configuration as enabling would carry it; undefined when it is incomplete. */
  #layerConfig(
    manifest: ExtensionManifest,
    layer: 'host' | 'agent',
    previous: JsonValue | undefined,
    bound: ReadonlySet<string> = new Set(),
  ): { readonly missingSecrets: boolean } | undefined {
    let config
    try {
      config = carryExtensionConfig(manifest, layer, previous)
    } catch {
      return undefined
    }
    return {
      missingSecrets: configFields(layerConfigSchema(manifest, layer)).some(
        (field) =>
          field.kind === 'secret' && field.required && config[field.key] === undefined && !bound.has(field.key),
      ),
    }
  }

  // —— Execution ——

  /** Performs an action the actor was cleared for; approvals of the permissions it grants are implied. */
  async perform(action: ExtensionAction, actor: ExtensionActor): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    switch (action.kind) {
      case 'save':
        return this.#save(action, actor)
      case 'enable': {
        const plans =
          action.values === undefined && action.credentials === undefined ? undefined : this.#enablePlans(action)
        const problem = this.enablementProblem(action.agentId, action.extensionId, this.#hostBound(action))
        if (problem !== undefined) throw new Error(problem)
        const missing = this.enablementMissing(action.agentId, action.extensionId, action.values)
        if (missing !== undefined) throw new Error(missing)
        const revision = this.#currentRevision(action.extensionId)
        const coordinator = runtime.extensions
        const host = coordinator.hostRequirement(action.extensionId, revision.id)
        const agent = coordinator.agentRequirement(action.agentId, action.extensionId, revision.id)
        await coordinator.activate({
          agentId: action.agentId,
          extensionId: action.extensionId,
          revisionId: revision.id,
          ...(plans === undefined || (plans.host !== undefined && !plans.agentGiven)
            ? {}
            : { config: this.#initialConfig(plans.agent, action) }),
          ...(agent.approvalRequired ? { permissionApproval: { permissionDigest: agent.permissionDigest } } : {}),
          ...(host.approvalRequired ? { hostPermissionApproval: { permissionDigest: host.permissionDigest } } : {}),
        })
        runtime.extensionConfig.recordCurrent(
          { extensionId: action.extensionId, layer: 'agent', agentId: action.agentId },
          this.#configMeta(action, actor),
        )
        const hostNote = plans?.host === undefined ? '' : await this.#writeHostAtEnable(action, actor)
        const note = this.enablementNote(action.agentId, action.extensionId)
        return {
          message: `已给${this.#agentName(action.agentId)}启用「${this.#extensionName(action.extensionId)}」。${hostNote}${note ?? ''}`,
          extensionId: action.extensionId,
          revisionId: revision.id,
        }
      }
      case 'configure':
      case 'revert-config': {
        const plan = this.configPlan(action)
        const where = this.#configPlace(plan.owner)
        if (runtime.extensionConfig.stored(plan.owner) === undefined) {
          throw new Error(
            plan.owner.layer === 'host'
              ? `「${this.#extensionName(plan.owner.extensionId)}」还没有安装到本机。${HOST_CONFIG_AT_ENABLE}`
              : `还没有给${this.#agentName(plan.owner.agentId!)}启用「${this.#extensionName(plan.owner.extensionId)}」，先用 enable 启用，可以在 values 里带上配置。`,
          )
        }
        if (plan.change.changed.length === 0) return { message: `${where}没有变化。`, extensionId: action.extensionId }
        const version = await runtime.extensionConfig.writeOrRestore({
          owner: plan.owner,
          config: plan.change.config,
          bindings: plan.change.bindings,
          meta: this.#configMeta(action, actor),
        })
        const fields = plan.change.changed.map((entry) => entry.field.title).join('、')
        return {
          message:
            action.kind === 'revert-config'
              ? `${where}已恢复到第 ${runtime.extensionConfig.version(action.versionId).version} 版（${fields}），成为第 ${version.version} 版。`
              : `${where}已修改：${fields}（第 ${version.version} 版）。`,
          extensionId: action.extensionId,
        }
      }
      case 'edit-info': {
        const extension = runtime.repository.getExtension(action.extensionId)
        if (!extension) throw new Error('这个扩展已经不在本机。')
        const updated = runtime.extensionService.updateDetails(action.extensionId, {
          displayName: action.name?.trim() || extension.displayName,
          description: action.description ?? extension.description,
        })
        runtime.publishExtensionsChange?.()
        return {
          message:
            updated.displayName === extension.displayName
              ? `已修改「${updated.displayName}」的扩展信息。`
              : `已把「${extension.displayName}」改名为「${updated.displayName}」。`,
          extensionId: action.extensionId,
        }
      }
      case 'disable': {
        await runtime.extensions.disable(action.agentId, action.extensionId)
        return {
          message: `已给${this.#agentName(action.agentId)}停用「${this.#extensionName(action.extensionId)}」。`,
          extensionId: action.extensionId,
        }
      }
      case 'switch':
        return this.#switch(action.extensionId, action.revisionId)
      case 'revert': {
        const previous = runtime.extensionData.latestSwitch(action.extensionId)
        if (!previous) throw new Error('没有找到上一次切换的记录，请在扩展详情里选择要切回的版本。')
        const revision = runtime.repository.getExtensionRevision(previous.fromRevisionId)
        if (!revision) throw new Error('上一个版本已经不在本机。')
        return this.#switch(action.extensionId, revision.id, previous.snapshotId)
      }
      case 'branch': {
        const source = runtime.repository.getExtensionRevision(action.revisionId)
        if (!source) throw new Error('要分支的版本不存在。')
        const branched = await runtime.extensionService.createBranch({
          source,
          slug: action.slug ?? slugFrom(action.name, 'branch'),
          displayName: action.name,
          description: runtime.repository.getExtension(source.extensionId)?.description ?? '',
          ...(actor.kind === 'agent' ? { createdByAgentId: actor.agentId } : {}),
          dshVersion: DEEPSEEK_HARNESS_VERSION,
        })
        if (action.copyData) runtime.extensionData.copyAll(source.extensionId, branched.extension.id)
        return {
          message: `已创建分支「${branched.extension.displayName}」${action.copyData ? '，并复制了现有数据' : ''}。`,
          extensionId: branched.extension.id,
          revisionId: branched.revision.id,
        }
      }
      case 'migrate-data': {
        const result = await runtime.extensions.withStopped(action.targetExtensionId, () =>
          runtime.extensionData.migrate({
            source: action.source,
            targetExtensionId: action.targetExtensionId,
            mode: action.mode,
            scope: { owners: 'all', index: true, library: true },
          }),
        )
        const config =
          action.includeConfig === true
            ? await new ExtensionConfigMigration(runtime).apply(
                { source: action.source, targetExtensionId: action.targetExtensionId, mode: action.mode },
                actor.kind === 'administrator' ? 'chat-admin' : actor.kind === 'agent' ? 'agent' : 'console',
              )
            : undefined
        const { storage, index, library } = result.preview.diff
        const configNote =
          config === undefined
            ? ''
            : `；配置改了 ${config.hostFields.length + config.agents.reduce((sum, entry) => sum + entry.fields.length, 0)} 项（凭据不迁移）`
        return {
          message: `已把数据迁移到「${this.#extensionName(action.targetExtensionId)}」：记录新增 ${storage.added}、覆盖 ${storage.overwritten}、删除 ${storage.removed}；索引 ${index.added + index.overwritten} 条；素材 ${library.added} 个${configNote}。迁移前的数据已留快照，可以恢复。`,
          extensionId: action.targetExtensionId,
        }
      }
      case 'community-publish':
        return this.#publish(action.extensionId, action.revisionId, action.notes, action.listing)
      case 'community-update':
        return this.#communityUpdate(action.extensionId)
      case 'community-install':
        return this.#communityInstall(action.communityExtensionId, action.agentId, action.release?.id)
      case 'community-withdraw': {
        await runtime.community.withdraw(action.releaseId)
        return { message: '已撤回这次发布。' }
      }
      case 'use-credential': {
        const credential = runtime.credentialLibrary.get(action.credentialId)
        if (credential === undefined) throw new Error('这个凭据已经被删除。')
        await runtime.credentialLibrary.approve(action.credentialId, action.agentId)
        const allowed = `${this.#agentName(action.agentId)}可以使用凭据「${credential.name}」了。`
        if (action.taskId === undefined || action.key === undefined) return { message: allowed }
        const task = runtime.repository.getAuthoringTask(action.taskId)
        if (task === undefined) throw new Error('这个创造任务已经不在了。')
        await runtime.authoringTestConfig.bindCredential(
          action.taskId,
          action.key,
          namedCredentialReference(action.credentialId),
        )
        return { message: `${allowed}「${task.title}」的试运行已经用上它。` }
      }
      case 'restart-host': {
        const restart = runtime.hostRestart
        const blocked =
          restart === undefined ? '这台 NekroNXT 不能从内部重启，请在它的运行环境里重启。' : restart.blockedReason()
        if (restart === undefined || blocked !== undefined) throw new Error(blocked ?? '')
        const { estimatedSeconds } = restart.status()
        if (action.channelId !== undefined) {
          await runtime.channels
            .sendHostNotice({
              channelId: action.channelId,
              noticeKey: `host-restart:${Date.now()}`,
              parts: [{ type: 'text', text: `正在重启，大约 ${estimatedSeconds} 秒后回来。` }],
            })
            .catch((error: unknown) => console.error('[nekro-nxt] 重启通知发送失败：', error))
        }
        restart.request()
        return { message: '已安排重启。' }
      }
    }
  }

  // —— Internals ——

  /**
   * Saves the task's candidate; with `enable`, then enables the saved extension for the agent with the configuration
   * given. A failed enabling keeps the save and says both.
   */
  async #save(action: SaveAction, actor: ExtensionActor): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    const prepared = await this.prepare(action)
    const enable = prepared.kind === 'save' ? prepared.enable : undefined
    if (enable?.attemptId !== undefined) {
      if (runtime.repository.listAuthoringAttempts(action.taskId).at(-1)?.id !== enable.attemptId) {
        throw new Error(CANDIDATE_CHANGED)
      }
      this.#candidates.delete(enable.attemptId)
    }
    const saved = await runtime.authoring.saveTask({
      taskId: action.taskId,
      ...(action.name === undefined ? {} : { name: action.name }),
      ...(action.slug === undefined ? {} : { slug: action.slug }),
      ...(action.description === undefined ? {} : { description: action.description }),
      ...(actor.kind === 'agent' ? { fromAgentTurn: true } : {}),
    })
    const label = this.#label(saved.revision)
    const result = { extensionId: saved.extension.id, revisionId: saved.revision.id }
    const done = `已保存「${saved.extension.displayName}」${label}。`
    if (enable === undefined) return { ...result, message: done }
    const installed = runtime.repository.getHostInstallation(saved.extension.id)?.extensionRevisionId
    if (installed !== undefined && installed !== saved.revision.id) {
      try {
        const switched = await this.#switch(saved.extension.id, saved.revision.id)
        return { ...result, message: `${done}${switched.message}` }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { ...result, message: `已保存「${saved.extension.displayName}」${label}，切换没有完成：${reason}` }
      }
    }
    try {
      const enabled = await this.perform(
        {
          kind: 'enable',
          extensionId: saved.extension.id,
          agentId: enable.agentId,
          ...(enable.values === undefined ? {} : { values: enable.values }),
          ...(enable.credentials === undefined ? {} : { credentials: enable.credentials }),
          ...(enable.actorAgentId === undefined ? {} : { actorAgentId: enable.actorAgentId }),
          ...(enable.requesterMemberId === undefined ? {} : { requesterMemberId: enable.requesterMemberId }),
          ...(enable.reason === undefined ? {} : { reason: enable.reason }),
        },
        actor,
      )
      return { ...result, message: `${done}${enabled.message}` }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ...result, message: `已保存「${saved.extension.displayName}」${label}，启用没有完成：${reason}` }
    }
  }

  /**
   * Writes the host-layer part of `enable` once the host installation exists. Enabling has happened by then, so a
   * failed write is reported in the message instead of undoing it.
   */
  async #writeHostAtEnable(action: EnableAction, actor: ExtensionActor): Promise<string> {
    try {
      // Planned again against the installation enabling just created, so its carried defaults stay.
      const host = this.#enablePlans(action).host
      if (host === undefined || host.change.changed.length === 0) return ''
      await this.#runtime.extensionConfig.writeOrRestore({
        owner: host.owner,
        config: host.change.config,
        bindings: host.change.bindings,
        meta: this.#configMeta(action, actor),
      })
      return `本机配置已设置：${host.change.changed.map((entry) => entry.field.title).join('、')}。`
    } catch (error) {
      return `本机配置没有设置成功：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** The agent-layer configuration `enable` starts with: the given values over the stored ones, credentials bound. */
  #initialConfig(plan: ConfigPlan, action: Extract<ExtensionAction, { readonly kind: 'enable' }>): JsonValue {
    const stored = this.#runtime.repository.getActivation(action.agentId, action.extensionId)?.config
    const previous =
      stored !== null && stored !== undefined && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
    const secretKeys = configFields(layerConfigSchema(this.#runtime.extensionConfig.manifest(plan.owner), 'agent'))
      .filter((field) => field.kind === 'secret')
      .map((field) => field.key)
    const secrets: Record<string, JsonValue> = {}
    for (const key of secretKeys) {
      const binding = plan.change.bindings[key]
      if (binding !== undefined && binding !== null) secrets[key] = namedCredentialReference(binding)
      else if (binding === undefined && typeof previous[key] === 'string') secrets[key] = previous[key]
    }
    return { ...plan.change.config, ...secrets }
  }

  /** Who a configuration write comes from, for its version record. */
  #configMeta(
    action: Extract<ExtensionAction, { readonly kind: 'enable' | 'configure' | 'revert-config' }>,
    actor: ExtensionActor,
  ): ExtensionConfigWriteMeta {
    const actorAgentId = action.actorAgentId ?? (actor.kind === 'agent' ? actor.agentId : undefined)
    return {
      source:
        action.kind === 'revert-config'
          ? 'revert'
          : actorAgentId !== undefined
            ? 'agent'
            : actor.kind === 'administrator'
              ? 'chat-admin'
              : 'console',
      ...(actorAgentId === undefined ? {} : { actorAgentId }),
      ...(action.requesterMemberId === undefined ? {} : { requesterMemberId: action.requesterMemberId }),
      ...(action.reason === undefined ? {} : { reason: action.reason }),
    }
  }

  #configPlace(owner: ExtensionConfigOwner): string {
    const name = this.#extensionName(owner.extensionId)
    return owner.layer === 'host' ? `「${name}」的本机配置` : `${this.#agentName(owner.agentId!)}在「${name}」的配置`
  }

  async #switch(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId,
    restoreSnapshotId?: string,
  ): Promise<ExtensionActionResult> {
    const coordinator = this.#runtime.extensions
    const host = coordinator.hostRequirement(extensionId, revisionId)
    const agents = coordinator.switchAgentRequirement(extensionId, revisionId)
    const revision = this.#runtime.repository.getExtensionRevision(revisionId)
    if (!revision) throw new Error('目标版本不存在。')
    const install = (restore?: string) =>
      coordinator.install({
        extensionId,
        revisionId,
        ...(host.approvalRequired ? { permissionApproval: { permissionDigest: host.permissionDigest } } : {}),
        ...(agents?.approvalRequired ? { agentPermissionApproval: { permissionDigest: agents.permissionDigest } } : {}),
        ...(restore === undefined ? {} : { restoreDataSnapshotId: restore }),
      })
    try {
      await install()
    } catch (error) {
      if (!(error instanceof ExtensionDataDowngradeError) || restoreSnapshotId === undefined) throw error
      await install(restoreSnapshotId)
    }
    return {
      message: `「${this.#extensionName(extensionId)}」已切换到 ${this.#label(revision)}。`,
      extensionId,
      revisionId,
    }
  }

  /**
   * Publishes one Revision with its lineage and records the release here, so this machine owns the line and knows
   * which public version its local one is.
   */
  async publishRevision(input: {
    readonly extensionId: ExtensionId
    readonly revisionId?: ExtensionRevisionId | undefined
    readonly notes: string
    readonly listing?: Parameters<NekroRuntime['community']['publish']>[0]['listing']
  }): Promise<Awaited<ReturnType<NekroRuntime['community']['publish']>> & { readonly revision: Revision }> {
    const runtime = this.#runtime
    const revision =
      input.revisionId === undefined
        ? this.#currentRevision(input.extensionId)
        : runtime.repository.getExtensionRevision(input.revisionId)
    if (!revision || revision.extensionId !== input.extensionId) throw new Error('要发布的版本不存在。')
    const status = await runtime.community.status()
    if (!status.account) {
      throw new CommunityError(401, '这台 NekroNXT 还没有登录社区，请先在「社区 → 账号」登录。', 'community-signed-out')
    }
    const exported = await createExtensionRevisionExport(runtime, input.extensionId, revision.id)
    const published = await runtime.community.publish({
      filename: exported.filename,
      body: exported.body,
      notes: input.notes,
      ...(input.listing === undefined ? {} : { listing: input.listing }),
    })
    runtime.communitySync.recordPublish(revision, {
      releaseId: published.releaseId,
      number: published.releaseNumber,
      publisherHandle: status.account.handle,
    })
    return { ...published, revision }
  }

  async #publish(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId | undefined,
    notes: string,
    listing: Extract<ExtensionAction, { readonly kind: 'community-publish' }>['listing'],
  ): Promise<ExtensionActionResult> {
    const { revision, releaseId, pageUrl } = await this.publishRevision({
      extensionId,
      revisionId,
      notes,
      ...(listing === undefined ? {} : { listing }),
    })
    return {
      message: `已把「${this.#extensionName(extensionId)}」${this.#label(revision)} 发布到社区，审查结果出来后会再通知。`,
      extensionId,
      revisionId: revision.id,
      releaseId,
      pageUrl,
    }
  }

  async #importRelease(releaseId: string, publisherHandle: string, number: number | undefined): Promise<Revision> {
    const runtime = this.#runtime
    const bytes = await runtime.community.downloadRelease(releaseId)
    const parsed = parseExtensionImport(bytes)
    const slugTaken = runtime.repository.getExtensionBySlug(parsed.manifest.extension.slug)
    const result = await runtime.extensionService.importRevision({
      extension: parsed.manifest.extension,
      revision: parsed.manifest.revision,
      manifest: parsed.revisionManifest,
      sources: parsed.sources,
      resources: parsed.resources,
      dshVersion: DEEPSEEK_HARNESS_VERSION,
      origin: 'community',
      ...(slugTaken !== undefined && slugTaken.id !== parsed.manifest.extension.id
        ? { localSlug: `${parsed.manifest.extension.slug}-${Date.now().toString(36)}`.slice(0, 64) }
        : {}),
    })
    runtime.communitySync.recordInstall(result.revision, {
      releaseId,
      ...(number === undefined ? {} : { number }),
      publisherHandle,
    })
    return result.revision
  }

  async #communityUpdate(extensionId: ExtensionId): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    const item =
      runtime.communitySync.cachedItem(extensionId) ??
      (await runtime.communitySync.check()).items.find((entry) => entry.extensionId === extensionId)
    if (!item?.latest) throw new Error('社区上没有这个扩展可用的发布。')
    if (item.status === 'same') return { message: '已经是社区上的最新版本。', extensionId }
    const detail = await runtime.community.getExtension(extensionId)
    const revision = await this.#importRelease(item.latest.id, detail.publisher.handle, item.latest.number)
    const result = await this.#switch(extensionId, revision.id)
    await runtime.communitySync.check().catch(() => undefined)
    const number = item.latest.number === undefined ? '' : ` #${item.latest.number}`
    return { ...result, message: `已更新到社区最新发布${number}。${result.message}` }
  }

  async #communityInstall(
    communityExtensionId: string,
    agentId: AgentId | undefined,
    approvedReleaseId: string | undefined,
  ): Promise<ExtensionActionResult> {
    const runtime = this.#runtime
    const detail = await runtime.community.getExtension(communityExtensionId)
    if (!detail.latest) throw new Error('这个扩展在社区上还没有可安装的发布。')
    if (approvedReleaseId !== undefined && detail.latest.id !== approvedReleaseId) {
      const number = detail.latest.number === undefined ? '' : `（#${detail.latest.number}）`
      throw new Error(`社区上这个扩展已经有了新的发布${number}，和申请时的不一样，没有安装。请重新发起安装申请。`)
    }
    const revision = await this.#importRelease(detail.latest.id, detail.publisher.handle, detail.latest.number)
    const installed = `已从社区安装「${detail.displayName}」`
    const result = { extensionId: revision.extensionId, revisionId: revision.id }
    if (agentId === undefined) return { ...result, message: `${installed}。` }
    // Enabling follows its own rules: an install approval does not cover missing configuration.
    const blocked =
      this.enablementProblem(agentId, revision.extensionId) ?? this.enablementMissing(agentId, revision.extensionId)
    if (blocked !== undefined) {
      return {
        ...result,
        message: `${installed}，还没有启用：${blocked}${this.configGuidance(agentId, revision.extensionId) ?? ''}`,
      }
    }
    await this.perform({ kind: 'enable', extensionId: revision.extensionId, agentId }, { kind: 'console' })
    return {
      ...result,
      message: `${installed}，并给${this.#agentName(agentId)}启用。${this.configGuidance(agentId, revision.extensionId) ?? ''}`,
    }
  }

  /**
   * Configuration fields of an extension that still have no value, sorted by who can fill them: the agent itself, the
   * agent with an administrator's confirmation, a credential binding, or an administrator in the console. Judged as
   * configure judges a change an administrator asked the agent for. Undefined when every field has a value.
   */
  configGuidance(agentId: AgentId, extensionId: ExtensionId): string | undefined {
    const runtime = this.#runtime
    const revision = this.#maybeCurrent(extensionId)
    const manifest = revision === undefined ? undefined : runtime.extensionService.revisionManifest(revision)
    if (!manifest) return undefined
    const actor = { kind: 'agent', agentId, requester: 'admin' } as const
    const groups = { run: [] as string[], request: [] as string[], credential: [] as string[], console: [] as string[] }
    for (const layer of ['agent', 'host'] as const) {
      const stored =
        layer === 'host'
          ? runtime.repository.getHostInstallation(extensionId)?.config
          : runtime.repository.getActivation(agentId, extensionId)?.config
      const values = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
      for (const entry of leveledConfigFields(manifest, layer)) {
        const { field, level } = entry
        const value = values[field.key]
        if (field.default !== undefined || (value !== undefined && value !== null && value !== '')) continue
        const where = level === 'secret' && layer === 'host' ? '，本机配置' : ''
        const name = `「${field.title}」（${field.key}${where}${field.required ? '，必填' : ''}）`
        const decision = this.configureDecision(layer, entry, actor)
        groups[decision === 'console' ? 'console' : level === 'secret' ? 'credential' : decision].push(name)
      }
    }
    const list = (names: readonly string[]) =>
      names.length > 8 ? `${names.slice(0, 8).join('、')}等 ${names.length} 项` : names.join('、')
    const lines = [
      groups.run.length === 0 ? '' : `你可以自己填：${list(groups.run)}，启用时放进 values，已经启用的用 configure。`,
      groups.request.length === 0 ? '' : `你可以填，但要管理员确认：${list(groups.request)}。`,
      groups.credential.length === 0
        ? ''
        : `要绑定凭据：${list(groups.credential)}。先用 nekro_nxt_credential_list 查，有合适的就用 credentials 按名称绑定（本机配置的用 configure 的 layer: host，要管理员确认），没有时用 nekro_nxt_credential_request 请管理员添加。`,
      groups.console.length === 0 ? '' : `要管理员在后台填写：${list(groups.console)}。`,
    ].filter((line) => line !== '')
    return lines.length === 0 ? undefined : `配置还有空着的项。${lines.join('')}`
  }

  /** Summary, permission risk and reach of an action, computed from local facts only. */
  #describe(
    action: ExtensionAction,
    actor: ExtensionActor,
  ): {
    readonly summary: string
    readonly level: PermissionLevel
    readonly added: readonly (PermissionItem | CommunityPermissionItem)[]
    readonly affectsOthers: boolean
  } {
    const runtime = this.#runtime
    const normal = { level: 'normal' as PermissionLevel, added: [], affectsOthers: false }
    const itemsOf = (revision: Revision | undefined): PermissionItem[] => {
      const manifest = revision === undefined ? undefined : runtime.extensionService.revisionManifest(revision)
      return manifest === undefined ? [] : summarizePermissions(manifest)
    }
    const otherAgents = (extensionId: ExtensionId, except?: AgentId) =>
      runtime.repository
        .listActivations()
        .some((activation) => activation.extensionId === extensionId && activation.agentId !== except)
    switch (action.kind) {
      case 'save': {
        const task = runtime.repository.getAuthoringTask(action.taskId)
        const target =
          task?.targetExtensionId === undefined ? undefined : runtime.repository.getExtension(task.targetExtensionId)
        const summary = target
          ? `保存「${target.displayName}」的新版本`
          : `保存新扩展「${action.name ?? task?.title ?? ''}」`
        if (action.enable === undefined) return { ...normal, summary }
        const candidate = this.#saveCandidate(action)
        const installed = this.#installedTarget(action)
        if (installed !== undefined) {
          // Switching grants what the new version asks for beyond the installed one, as `switch` does.
          const added = addedPermissionItems(itemsOf(this.#maybeCurrent(installed)), [...(candidate?.items ?? [])])
          return {
            summary: `${summary}并切换过去`,
            level: highestPermissionLevel(added),
            added,
            affectsOthers: otherAgents(installed, actor.kind === 'agent' ? actor.agentId : undefined),
          }
        }
        // Enabling grants what the candidate asks for; nothing of a new extension is installed yet.
        const items = candidate?.items ?? []
        let mentions: readonly ConfigMention[] = []
        if (candidate !== undefined) {
          try {
            const fields = this.#saveConfigFields(candidate, action.enable)
            mentions = this.#mentions(fields, action.enable.credentials)
          } catch {
            mentions = []
          }
        }
        return {
          summary: `${summary}并给${this.#agentName(action.enable.agentId)}启用${configMentions(mentions)}`,
          level: highestPermissionLevel(items),
          added: items,
          affectsOthers: false,
        }
      }
      case 'enable': {
        const revision = this.#maybeCurrent(action.extensionId)
        const installed = runtime.repository.getHostInstallation(action.extensionId) !== undefined
        const items = itemsOf(revision).filter((item) => item.layer === 'agent' || !installed)
        let mentions: readonly ConfigMention[] = []
        if (action.values !== undefined || action.credentials !== undefined) {
          try {
            const plans = this.#enablePlans(action)
            mentions = this.#mentions(
              { agent: plans.agent.change.changed, host: plans.host?.change.changed ?? [] },
              action.credentials,
            )
          } catch {
            mentions = []
          }
        }
        return {
          summary: `给${this.#agentName(action.agentId)}启用「${this.#extensionName(action.extensionId)}」${configMentions(mentions)}`,
          level: highestPermissionLevel(items),
          added: items,
          affectsOthers: false,
        }
      }
      case 'disable':
        return {
          ...normal,
          summary: `给${this.#agentName(action.agentId)}停用「${this.#extensionName(action.extensionId)}」`,
        }
      case 'edit-info': {
        const current = this.#extensionName(action.extensionId)
        const name = action.name?.trim()
        const renamed = name !== undefined && name !== '' && name !== current
        const parts = [renamed ? `名称改为「${name}」` : '', action.description === undefined ? '' : '修改说明']
        return {
          ...normal,
          summary: `修改「${current}」的扩展信息：${parts.filter((part) => part !== '').join('，') || '没有变化'}`,
        }
      }
      case 'switch':
      case 'revert': {
        const current = this.#maybeCurrent(action.extensionId)
        const targetId =
          action.kind === 'switch'
            ? action.revisionId
            : runtime.extensionData.latestSwitch(action.extensionId)?.fromRevisionId
        const target = targetId === undefined ? undefined : runtime.repository.getExtensionRevision(targetId)
        const added = addedPermissionItems(itemsOf(current), itemsOf(target))
        return {
          summary:
            action.kind === 'revert'
              ? `把「${this.#extensionName(action.extensionId)}」回退到上一个版本${target ? ` ${this.#label(target)}` : ''}`
              : `把「${this.#extensionName(action.extensionId)}」切换到 ${target ? this.#label(target) : '指定版本'}`,
          level: highestPermissionLevel(added),
          added,
          affectsOthers: otherAgents(action.extensionId, actor.kind === 'agent' ? actor.agentId : undefined),
        }
      }
      case 'branch': {
        const source = runtime.repository.getExtensionRevision(action.revisionId)
        return {
          ...normal,
          summary: `从「${source ? this.#extensionName(source.extensionId) : ''}」${source ? this.#label(source) : ''} 创建分支「${action.name}」${action.copyData ? '并复制数据' : ''}`,
        }
      }
      case 'migrate-data':
        return {
          ...normal,
          summary: `把${action.source.kind === 'snapshot' ? '数据快照' : `「${this.#extensionName(action.source.extensionId)}」的数据`}${action.mode === 'replace' ? '替换' : '覆盖'}到「${this.#extensionName(action.targetExtensionId)}」`,
          affectsOthers: otherAgents(action.targetExtensionId),
        }
      case 'community-publish': {
        const revision =
          action.revisionId === undefined
            ? this.#maybeCurrent(action.extensionId)
            : runtime.repository.getExtensionRevision(action.revisionId)
        // Shown against the newest public release this machine knows of; a first release shows all it asks for. The
        // risk level stays normal: publishing runs nothing here.
        const previous = runtime.communitySync.cachedItem(action.extensionId)?.latest?.permissions
        const items = itemsOf(revision)
        return {
          ...normal,
          added:
            previous === undefined
              ? items
              : addedPermissionItems(
                  previous.map((item) => ({
                    key: item.key,
                    level: item.level,
                    label: item.label,
                    layer: item.layer ?? 'agent',
                  })),
                  items,
                ),
          summary: `把「${this.#extensionName(action.extensionId)}」${revision ? this.#label(revision) : ''} 发布到社区`,
        }
      }
      case 'community-update': {
        const item = runtime.communitySync.cachedItem(action.extensionId)
        return {
          summary: `把「${this.#extensionName(action.extensionId)}」更新到社区最新发布`,
          level: highestPermissionLevel(item?.addedPermissions ?? []),
          added: item?.addedPermissions ?? [],
          affectsOthers: otherAgents(action.extensionId, actor.kind === 'agent' ? actor.agentId : undefined),
        }
      }
      case 'community-install': {
        const release = action.release
        if (release === undefined) return { ...normal, summary: '从社区安装扩展' }
        const facts = [
          communityPublisherLabel(release.publisherHandle),
          `审查${REVIEW_STATUS_LABEL[release.reviewStatus]}`,
          ...(release.ratingScore === null ? [] : [`评分 ${release.ratingScore.toFixed(1)}`]),
        ]
        return {
          summary: `从社区安装「${release.displayName}」${release.number === undefined ? '' : ` #${release.number}`}（${facts.join('，')}）`,
          level: highestPermissionLevel(release.permissions),
          added: release.permissions,
          affectsOthers: false,
        }
      }
      case 'community-withdraw':
        return { ...normal, summary: '撤回一次社区发布' }
      case 'configure':
      case 'revert-config': {
        let plan: ConfigPlan | undefined
        try {
          plan = this.configPlan(action)
        } catch {
          plan = undefined
        }
        const where =
          plan === undefined ? `「${this.#extensionName(action.extensionId)}」的配置` : this.#configPlace(plan.owner)
        const fields = plan?.change.changed.map((entry) => entry.field.title).join('、') ?? ''
        const record =
          action.kind === 'revert-config'
            ? runtime.repository.extensionConfigVersions.getExtensionConfigVersion(action.versionId)
            : undefined
        return {
          ...normal,
          summary:
            action.kind === 'revert-config'
              ? `把${where}恢复到第 ${record?.version ?? '?'} 版${fields === '' ? '' : `（${fields}）`}`
              : `修改${where}${fields === '' ? '' : `：${fields}`}`,
          affectsOthers: plan?.owner.layer === 'host',
        }
      }
      case 'use-credential': {
        const credential = runtime.credentialLibrary.get(action.credentialId)
        return {
          ...normal,
          summary: `让${this.#agentName(action.agentId)}使用凭据「${credential?.name ?? '已删除的凭据'}」`,
        }
      }
      case 'restart-host':
        return { ...normal, summary: '重启 NekroNXT' }
    }
  }

  #mentions(
    fields: Readonly<Record<ExtensionConfigLayer, readonly LeveledConfigField[]>>,
    credentials: Readonly<Record<string, string | null>> | undefined,
  ): readonly ConfigMention[] {
    return (['host', 'agent'] as const).flatMap((layer) =>
      fields[layer].map(({ field }) =>
        field.kind === 'secret' ? { layer, field, credential: credentials?.[field.key] ?? null } : { layer, field },
      ),
    )
  }

  /** Why an agent may not touch this target at all, or undefined when it may. */
  #agentScope(action: ExtensionAction, agentId: AgentId): string | undefined {
    const runtime = this.#runtime
    switch (action.kind) {
      case 'save': {
        const task = runtime.repository.getAuthoringTask(action.taskId)
        if (task?.agentId !== agentId) return '只能保存自己的创造任务。'
        return action.enable === undefined || action.enable.agentId === agentId
          ? undefined
          : '只能给自己启用或停用扩展。'
      }
      case 'enable':
      case 'disable':
        return action.agentId === agentId ? undefined : '只能给自己启用或停用扩展。'
      case 'configure':
        return action.layer === 'host' || action.agentId === agentId ? undefined : '只能修改自己的智能体配置。'
      case 'revert-config': {
        const record = runtime.repository.extensionConfigVersions.getExtensionConfigVersion(action.versionId)
        return record === undefined || record.agentId === null || record.agentId === agentId
          ? undefined
          : '只能恢复自己的智能体配置。'
      }
      case 'switch':
      case 'revert':
      case 'edit-info':
      case 'community-update':
      case 'community-publish':
      case 'branch':
      case 'migrate-data':
        return undefined
      case 'community-install':
        return action.agentId === undefined || action.agentId === agentId ? undefined : '只能给自己安装启用。'
      case 'community-withdraw':
        return undefined
      case 'use-credential': {
        if (action.agentId !== agentId) return '只能为自己申请使用凭据。'
        if (action.taskId === undefined) return undefined
        return runtime.repository.getAuthoringTask(action.taskId)?.agentId === agentId
          ? undefined
          : '只能在自己的创造任务里使用凭据。'
      }
      case 'restart-host':
        return undefined
    }
  }

  #maybeCurrent(extensionId: ExtensionId): Revision | undefined {
    const installed = this.#runtime.repository.getHostInstallation(extensionId)?.extensionRevisionId
    const revisions = this.#runtime.repository.listExtensionRevisions(extensionId)
    return revisions.find((revision) => revision.id === installed) ?? revisions.at(-1)
  }

  #currentRevision(extensionId: ExtensionId): Revision {
    const revision = this.#maybeCurrent(extensionId)
    if (!revision) throw new Error('这个扩展没有可用的版本。')
    return revision
  }

  #label(revision: Revision): string {
    return (
      extensionVersions(this.#runtime.repository, this.#runtime.extensionService, revision.extensionId).get(revision.id)
        ?.label ?? ''
    )
  }

  #extensionName(extensionId: ExtensionId): string {
    return this.#runtime.repository.getExtension(extensionId)?.displayName ?? '扩展'
  }

  #agentName(agentId: AgentId): string {
    return this.#runtime.repository.getAgent(agentId)?.revision.displayName ?? '智能体'
  }
}

export type { JsonValue }
