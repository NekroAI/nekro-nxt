import { promptDocumentPlainText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import type { AgentAccessLevel } from '../../agent-access-level.js'
import type {
  AgentCompactionPolicy,
  AgentFallbackModel,
  AgentSubConversationModels,
  AgentSummary,
  ImageUnderstandingPolicy,
  ModelSummary,
} from '../../product-runtime.js'
import { agentModelKey } from './agent-create-draft.js'

export type Capabilities = AgentSummary['capabilities']
export type AccessCapability = 'fileTools' | 'developmentShell' | 'unrestrictedFileAccess'

export type DraftUpdate = (update: (draft: AgentDraft) => AgentDraft) => void

/**
 * The editable configuration of one agent. Every field here is saved together through the save bar; channel
 * triggers and extensions apply immediately and are not part of it.
 */
export interface AgentDraft {
  readonly name: string
  readonly persona: PromptDocumentV1
  readonly personaText: string
  readonly modelKey: string
  /** Thinking level for the main model; empty uses the model's own default. */
  readonly effort: string
  readonly visionKey: string
  /** Recent images put back into the conversation after compaction. */
  readonly imageRestore: ImageRestorePolicy
  /** Which model writes each kind of compaction summary. */
  readonly compaction: AgentCompactionPolicy
  /** Models it may open sub-conversations with; names may be untrimmed while being typed. */
  readonly subConversationModels: AgentSubConversationModels
  /** Models to switch to, in order, when the main model fails. */
  readonly fallbackModels: readonly AgentFallbackModel[]
  /** Extra names that wake it in smart mode, as typed: separated by commas, 、 or spaces. */
  readonly aliases: string
  readonly capabilities: Capabilities
}

/** Aliases as they are saved: split, trimmed and without repeats. */
export const savedAliases = (text: string): readonly string[] => [
  ...new Set(
    text
      .split(/[,，、\s]+/u)
      .map((alias) => alias.trim())
      .filter((alias) => alias !== ''),
  ),
]

export type ImageRestorePolicy = ImageUnderstandingPolicy['history']['restoreAfterCompaction']

/** The saved image policy with the restore choice from the draft. */
export const withImageRestore = (
  policy: ImageUnderstandingPolicy,
  restore: ImageRestorePolicy,
): ImageUnderstandingPolicy => ({ ...policy, history: { ...policy.history, restoreAfterCompaction: { ...restore } } })

export const draftOf = (agent: AgentSummary): AgentDraft => ({
  name: agent.name,
  persona: agent.personaDocument,
  personaText: promptDocumentPlainText(agent.personaDocument),
  modelKey: agent.modelRef ? agentModelKey({ provider: agent.modelRef.provider, id: agent.modelRef.model }) : '',
  effort: agent.modelRef?.reasoningEffort ?? '',
  visionKey:
    agent.imagePolicy.textModel.mode === 'auxiliary'
      ? agentModelKey({
          provider: agent.imagePolicy.textModel.model.provider,
          id: agent.imagePolicy.textModel.model.model,
        })
      : '',
  imageRestore: { ...agent.imagePolicy.history.restoreAfterCompaction },
  compaction: agent.compaction,
  subConversationModels: agent.subConversationModels,
  fallbackModels: agent.fallbackModels,
  aliases: agent.aliases.join('、'),
  capabilities: agent.capabilities,
})

/** The candidates as they are saved: names and guidance trimmed, the default following its candidate. */
export const savedSubConversationModels = (policy: AgentSubConversationModels): AgentSubConversationModels => {
  const candidates = policy.candidates.map((candidate) => ({
    ...candidate,
    name: candidate.name.trim(),
    guidance: candidate.guidance.trim(),
  }))
  const chosen = policy.default?.trim()
  return chosen !== undefined && candidates.some((candidate) => candidate.name === chosen)
    ? { candidates, default: chosen }
    : { candidates }
}

const sameSubConversationModels = (left: AgentSubConversationModels, right: AgentSubConversationModels) =>
  JSON.stringify(savedSubConversationModels(left)) === JSON.stringify(savedSubConversationModels(right))

const CAPABILITY_KEYS = [
  'subagents',
  'fileTools',
  'webSearch',
  'dynamicCreation',
  'developmentShell',
  'unrestrictedFileAccess',
  'scheduledTasks',
  'codeRun',
  'commandNetwork',
  'communityFeedbackAuto',
] as const satisfies readonly (keyof Capabilities)[]
type BooleanCapability = (typeof CAPABILITY_KEYS)[number]
const OTHER_CAPABILITIES = ['subagents', 'webSearch', 'dynamicCreation', 'scheduledTasks'] as const
const ACCESS_KEYS = ['fileTools', 'developmentShell', 'unrestrictedFileAccess'] as const

const CAPABILITY_LABEL: Record<(typeof OTHER_CAPABILITIES)[number], string> = {
  subagents: '子对话',
  webSearch: '网页搜索',
  dynamicCreation: '动态创造',
  scheduledTasks: '定时任务',
}

const sameGrants = (left: Capabilities['commandAccounts'], right: Capabilities['commandAccounts']) =>
  JSON.stringify(left) === JSON.stringify(right)

const sameDocument = (left: PromptDocumentV1, right: PromptDocumentV1) => JSON.stringify(left) === JSON.stringify(right)

/** Fields saved through `reviseAgent` (identity, persona and models). */
export const identityChanged = (base: AgentDraft, draft: AgentDraft): boolean =>
  draft.name.trim() !== base.name ||
  !sameDocument(draft.persona, base.persona) ||
  draft.modelKey !== base.modelKey ||
  draft.effort !== base.effort ||
  draft.visionKey !== base.visionKey ||
  JSON.stringify(draft.imageRestore) !== JSON.stringify(base.imageRestore) ||
  JSON.stringify(draft.compaction) !== JSON.stringify(base.compaction) ||
  !sameSubConversationModels(draft.subConversationModels, base.subConversationModels) ||
  JSON.stringify(draft.fallbackModels) !== JSON.stringify(base.fallbackModels) ||
  JSON.stringify(savedAliases(draft.aliases)) !== JSON.stringify(savedAliases(base.aliases))

/** Capabilities that differ from the saved ones, as the partial patch the Host expects. */
export const capabilityPatch = (base: AgentDraft, draft: AgentDraft): Partial<Capabilities> => {
  const patch: Partial<Record<BooleanCapability, boolean>> & {
    commandAccounts?: Capabilities['commandAccounts']
    extensionAutonomy?: Capabilities['extensionAutonomy']
    extensionRequesters?: Capabilities['extensionRequesters']
    extensionConfigRequesters?: Capabilities['extensionConfigRequesters']
  } = {}
  for (const key of CAPABILITY_KEYS) {
    if (draft.capabilities[key] !== base.capabilities[key]) patch[key] = draft.capabilities[key]
  }
  if (!sameGrants(base.capabilities.commandAccounts, draft.capabilities.commandAccounts)) {
    patch.commandAccounts = draft.capabilities.commandAccounts
  }
  if (draft.capabilities.extensionAutonomy !== base.capabilities.extensionAutonomy) {
    patch.extensionAutonomy = draft.capabilities.extensionAutonomy
  }
  if (draft.capabilities.extensionRequesters !== base.capabilities.extensionRequesters) {
    patch.extensionRequesters = draft.capabilities.extensionRequesters
  }
  if (draft.capabilities.extensionConfigRequesters !== base.capabilities.extensionConfigRequesters) {
    patch.extensionConfigRequesters = draft.capabilities.extensionConfigRequesters
  }
  // System access is one level: send all three switches together so the request states the whole level.
  if (ACCESS_KEYS.some((key) => key in patch)) {
    for (const key of ACCESS_KEYS) patch[key] = draft.capabilities[key]
  }
  return patch
}

/** Human labels of the unsaved changes, in the order the page shows them. */
export const draftChanges = (base: AgentDraft, draft: AgentDraft): readonly string[] => {
  const changes: string[] = []
  if (draft.name.trim() !== base.name) changes.push('名称')
  if (JSON.stringify(savedAliases(draft.aliases)) !== JSON.stringify(savedAliases(base.aliases))) changes.push('别名')
  if (draft.modelKey !== base.modelKey) changes.push('主模型')
  if (draft.effort !== base.effort) changes.push('思考强度')
  if (JSON.stringify(draft.fallbackModels) !== JSON.stringify(base.fallbackModels)) changes.push('备用模型')
  if (draft.visionKey !== base.visionKey) changes.push('视觉模型')
  if (JSON.stringify(draft.imageRestore) !== JSON.stringify(base.imageRestore)) changes.push('压缩后附回图片')
  if (JSON.stringify(draft.compaction) !== JSON.stringify(base.compaction)) changes.push('压缩模型')
  if (!sameSubConversationModels(draft.subConversationModels, base.subConversationModels)) changes.push('子对话模型')
  const patch = capabilityPatch(base, draft)
  if ('fileTools' in patch || 'developmentShell' in patch || 'unrestrictedFileAccess' in patch) changes.push('系统访问')
  if ('codeRun' in patch) changes.push('编排模式')
  if ('commandNetwork' in patch) changes.push('命令联网')
  if ('commandAccounts' in patch) changes.push('关联账号')
  if ('communityFeedbackAuto' in patch) changes.push('免确认提交反馈')
  if ('extensionAutonomy' in patch) changes.push('扩展自主权')
  if ('extensionRequesters' in patch) changes.push('谁可以让它做扩展')
  if ('extensionConfigRequesters' in patch) changes.push('谁可以让它改配置')
  for (const key of OTHER_CAPABILITIES) {
    if (key in patch) changes.push(CAPABILITY_LABEL[key])
  }
  if (!sameDocument(draft.persona, base.persona)) changes.push('设定')
  return changes
}

/** The three access switches of a preset level; levels are cumulative. */
export const accessOfLevel = (level: AgentAccessLevel): Pick<Capabilities, AccessCapability> => ({
  fileTools: level >= 1,
  developmentShell: level >= 2,
  unrestrictedFileAccess: level >= 3,
})

/**
 * Sets one access switch and keeps the dependency: running commands and full access both work on files, so turning
 * either on turns on file access, and turning file access off turns both off.
 */
export const toggleAccess = (capabilities: Capabilities, key: AccessCapability, enabled: boolean): Capabilities => {
  if (key === 'fileTools' && !enabled) {
    return { ...capabilities, fileTools: false, developmentShell: false, unrestrictedFileAccess: false }
  }
  if (key !== 'fileTools' && enabled) return { ...capabilities, fileTools: true, [key]: true }
  return { ...capabilities, [key]: enabled }
}

const supportsImages = (model: ModelSummary | undefined) => model?.inputModalities?.includes('image') ?? false

/**
 * The image policy to save with the chosen models: a vision-capable main model reads images itself; otherwise the
 * chosen helper model (if any) describes them.
 */
export const imagePolicyFor = (
  current: ImageUnderstandingPolicy,
  model: ModelSummary,
  vision: ModelSummary | undefined,
): ImageUnderstandingPolicy =>
  supportsImages(model) || !vision
    ? { ...current, textModel: { mode: 'disabled' } }
    : {
        ...current,
        textModel: {
          mode: 'auxiliary',
          model: { provider: vision.provider, model: vision.id },
          maxTokens: current.textModel.mode === 'auxiliary' ? current.textModel.maxTokens : 1024,
        },
      }

export { supportsImages }
