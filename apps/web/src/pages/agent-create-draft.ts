import type { AgentSummary, ModelSummary } from '../product-store.js'

export const agentModelKey = (model: Pick<ModelSummary, 'provider' | 'id'>): string =>
  `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`

export interface AgentCreateDraft {
  readonly name: string
  readonly persona: string
  readonly selectedModelKey: string
  readonly capabilities: AgentSummary['capabilities']
}

export const createAgentDraft = (models: readonly ModelSummary[], webSearchAvailable: boolean): AgentCreateDraft => ({
  name: '',
  persona: '',
  selectedModelKey: models[0] ? agentModelKey(models[0]) : '',
  capabilities: {
    subagents: true,
    fileTools: false,
    webSearch: webSearchAvailable,
    dynamicCreation: false,
    developmentShell: false,
    unrestrictedFileAccess: false,
  },
})
