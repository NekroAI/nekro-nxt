import { promptDocumentPlainText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import type { AgentAccessLevel } from '../../agent-access-level.js'
import type { AgentSummary, ImageUnderstandingPolicy, ModelSummary } from '../../product-runtime.js'
import { agentModelKey } from './agent-create-draft.js'

export type Capabilities = AgentSummary['capabilities']
export type AccessCapability = 'fileTools' | 'developmentShell' | 'unrestrictedFileAccess'

/**
 * The editable configuration of one agent. Every field here is saved together through the save bar; channel
 * triggers and extensions apply immediately and are not part of it.
 */
export interface AgentDraft {
  readonly name: string
  readonly persona: PromptDocumentV1
  readonly personaText: string
  readonly modelKey: string
  readonly visionKey: string
  readonly capabilities: Capabilities
}

export const draftOf = (agent: AgentSummary): AgentDraft => ({
  name: agent.name,
  persona: agent.personaDocument,
  personaText: promptDocumentPlainText(agent.personaDocument),
  modelKey: agent.modelRef ? agentModelKey({ provider: agent.modelRef.provider, id: agent.modelRef.model }) : '',
  visionKey:
    agent.imagePolicy.textModel.mode === 'auxiliary'
      ? agentModelKey({
          provider: agent.imagePolicy.textModel.model.provider,
          id: agent.imagePolicy.textModel.model.model,
        })
      : '',
  capabilities: agent.capabilities,
})

const CAPABILITY_KEYS = [
  'subagents',
  'fileTools',
  'webSearch',
  'dynamicCreation',
  'developmentShell',
  'unrestrictedFileAccess',
  'scheduledTasks',
] as const satisfies readonly (keyof Capabilities)[]
const OTHER_CAPABILITIES = ['subagents', 'webSearch', 'dynamicCreation', 'scheduledTasks'] as const
const ACCESS_KEYS = ['fileTools', 'developmentShell', 'unrestrictedFileAccess'] as const

const CAPABILITY_LABEL: Record<(typeof OTHER_CAPABILITIES)[number], string> = {
  subagents: '子智能体',
  webSearch: '网页搜索',
  dynamicCreation: '动态创造',
  scheduledTasks: '定时任务',
}

const sameDocument = (left: PromptDocumentV1, right: PromptDocumentV1) => JSON.stringify(left) === JSON.stringify(right)

/** Fields saved through `reviseAgent` (identity, persona and models). */
export const identityChanged = (base: AgentDraft, draft: AgentDraft): boolean =>
  draft.name.trim() !== base.name ||
  !sameDocument(draft.persona, base.persona) ||
  draft.modelKey !== base.modelKey ||
  draft.visionKey !== base.visionKey

/** Capabilities that differ from the saved ones, as the partial patch the Host expects. */
export const capabilityPatch = (base: AgentDraft, draft: AgentDraft): Partial<Capabilities> => {
  const patch: Partial<Record<keyof Capabilities, boolean>> = {}
  for (const key of CAPABILITY_KEYS) {
    if (draft.capabilities[key] !== base.capabilities[key]) patch[key] = draft.capabilities[key]
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
  if (draft.modelKey !== base.modelKey) changes.push('主模型')
  if (draft.visionKey !== base.visionKey) changes.push('看图模型')
  const patch = capabilityPatch(base, draft)
  if ('fileTools' in patch || 'developmentShell' in patch || 'unrestrictedFileAccess' in patch) changes.push('系统访问')
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
