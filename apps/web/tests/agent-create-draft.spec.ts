import { describe, expect, it } from 'vitest'
import { agentModelKey, createAgentDraft } from '../src/pages/agent-create-draft.js'

describe('createAgentDraft', () => {
  it('returns the same defaults for every create entry and selects the first available model', () => {
    const models = [
      {
        provider: 'deepseek',
        providerName: 'DeepSeek',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
      },
    ]
    const first = createAgentDraft(models, true)
    const reopened = createAgentDraft(models, true)
    expect(first).toEqual(reopened)
    expect(first.selectedModelKey).toBe(agentModelKey(models[0]!))
    expect(first.capabilities).toEqual({
      subagents: true,
      fileTools: false,
      webSearch: true,
      dynamicCreation: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
    })
  })
})
