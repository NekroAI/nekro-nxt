import { describe, expect, it } from 'vitest'
import { promptDocumentFromText } from '@nekro-nxt/contracts'
import {
  accessOfLevel,
  capabilityPatch,
  draftChanges,
  identityChanged,
  imagePolicyFor,
  savedSubConversationModels,
  toggleAccess,
  type AgentDraft,
} from '../src/app/agents/agent-draft.js'
import { changeSummary, savedAt } from '../src/app/agents/agent-restore.js'
import { subConversationModelsProblem } from '../src/app/agents/sub-conversation-models.js'
import { defaultImageUnderstandingPolicy } from '../src/product-model.js'

const base: AgentDraft = {
  name: '资料员',
  persona: promptDocumentFromText('严谨、简洁'),
  personaText: '严谨、简洁',
  modelKey: 'fixture/text-model',
  effort: '',
  compaction: { inSession: { mode: 'follow' }, newSession: { mode: 'follow' } },
  subConversationModels: { candidates: [] },
  visionKey: '',
  capabilities: {
    subagents: true,
    fileTools: false,
    webSearch: false,
    dynamicCreation: false,
    developmentShell: false,
    unrestrictedFileAccess: false,
    scheduledTasks: true,
    codeRun: false,
    commandNetwork: true,
    communityFeedbackAuto: false,
    commandAccounts: [],
    extensionAutonomy: 'manual',
    extensionRequesters: 'everyone',
    extensionConfigRequesters: 'admins',
  },
}

describe('agent draft', () => {
  it('lists unsaved changes in page order and splits identity from capabilities', () => {
    const edited: AgentDraft = {
      ...base,
      name: '资料员二号',
      persona: promptDocumentFromText('更活泼'),
      personaText: '更活泼',
      capabilities: { ...base.capabilities, ...accessOfLevel(2), webSearch: true },
    }
    expect(draftChanges(base, edited)).toEqual(['名称', '系统访问', '网页搜索', '设定'])
    expect(identityChanged(base, edited)).toBe(true)
    expect(capabilityPatch(base, edited)).toEqual({
      fileTools: true,
      developmentShell: true,
      unrestrictedFileAccess: false,
      webSearch: true,
    })
    expect(draftChanges(base, base)).toEqual([])
    expect(identityChanged(base, { ...base, capabilities: { ...base.capabilities, subagents: false } })).toBe(false)
  })

  it('saves a changed thinking level with the identity', () => {
    const edited = { ...base, effort: 'high' }
    expect(draftChanges(base, edited)).toEqual(['思考强度'])
    expect(identityChanged(base, edited)).toBe(true)
  })

  it('saves changed compaction models with the identity', () => {
    const edited: AgentDraft = {
      ...base,
      compaction: {
        inSession: { mode: 'follow' },
        newSession: { mode: 'custom', model: { provider: 'fixture', model: 'fast-model' } },
      },
    }
    expect(draftChanges(base, edited)).toEqual(['压缩模型'])
    expect(identityChanged(base, edited)).toBe(true)
  })

  it('saves sub-conversation models with the identity, trimmed, and keeps the default on its candidate', () => {
    const candidate = { name: ' 快速 ', model: { provider: 'fixture', model: 'fast-model' }, guidance: ' 翻记录 ' }
    const edited: AgentDraft = { ...base, subConversationModels: { candidates: [candidate], default: ' 快速 ' } }
    expect(draftChanges(base, edited)).toEqual(['子对话模型'])
    expect(identityChanged(base, edited)).toBe(true)
    expect(savedSubConversationModels(edited.subConversationModels)).toEqual({
      candidates: [{ name: '快速', model: candidate.model, guidance: '翻记录' }],
      default: '快速',
    })
    // Spaces alone are not a change.
    const saved = { ...base, subConversationModels: savedSubConversationModels(edited.subConversationModels) }
    expect(identityChanged(saved, edited)).toBe(false)
  })

  it('names what keeps sub-conversation models from being saved', () => {
    const named = (name: string) => ({ name, model: { provider: 'fixture', model: 'fast-model' }, guidance: '' })
    expect(subConversationModelsProblem({ candidates: [named('快速'), named('深度')] })).toBeUndefined()
    expect(subConversationModelsProblem({ candidates: [named(' ')] })).toBe('子对话模型需要名称')
    expect(subConversationModelsProblem({ candidates: [named('主模型')] })).toBe('「主模型」是保留名称')
    expect(subConversationModelsProblem({ candidates: [named('快速'), named('快速 ')] })).toBe(
      '子对话模型的名称不能重复',
    )
  })

  it('ignores surrounding spaces in the name', () => {
    expect(draftChanges(base, { ...base, name: ' 资料员 ' })).toEqual([])
  })

  it('maps access levels cumulatively', () => {
    expect(accessOfLevel(0)).toEqual({ fileTools: false, developmentShell: false, unrestrictedFileAccess: false })
    expect(accessOfLevel(1)).toEqual({ fileTools: true, developmentShell: false, unrestrictedFileAccess: false })
    expect(accessOfLevel(3)).toEqual({ fileTools: true, developmentShell: true, unrestrictedFileAccess: true })
  })

  it('keeps manual access switches consistent', () => {
    const shell = toggleAccess(base.capabilities, 'developmentShell', true)
    expect(shell).toMatchObject({ fileTools: true, developmentShell: true, unrestrictedFileAccess: false })
    const full = toggleAccess(base.capabilities, 'unrestrictedFileAccess', true)
    expect(full).toMatchObject({ fileTools: true, developmentShell: false, unrestrictedFileAccess: true })
    expect(toggleAccess(full, 'fileTools', false)).toMatchObject({
      fileTools: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
    })
    expect(toggleAccess(shell, 'developmentShell', false)).toMatchObject({ fileTools: true, developmentShell: false })
  })

  it('uses a helper model only when the main model cannot read images', () => {
    const policy = defaultImageUnderstandingPolicy()
    const text = {
      provider: 'fixture',
      providerName: '示例',
      id: 'text-model',
      name: '文本',
      inputModalities: ['text'],
    }
    const vision = { ...text, id: 'vision-model', name: '视觉模型', inputModalities: ['text', 'image'] }
    expect(imagePolicyFor(policy, vision, undefined).textModel).toEqual({ mode: 'disabled' })
    expect(imagePolicyFor(policy, text, undefined).textModel).toEqual({ mode: 'disabled' })
    expect(imagePolicyFor(policy, text, vision).textModel).toEqual({
      mode: 'auxiliary',
      model: { provider: 'fixture', model: 'vision-model' },
      maxTokens: 1024,
    })
  })
})

describe('earlier configurations', () => {
  it('names a configuration by when it was saved, never by a number', () => {
    const now = new Date(2026, 9, 6, 12, 0).getTime()
    expect(savedAt(new Date(2026, 9, 4, 9, 5).getTime(), now)).toBe('10月4日 09:05')
    expect(savedAt(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('2025年12月31日 23:59')
  })

  it('summarises what each configuration changed', () => {
    expect(changeSummary({ changedFields: ['persona', 'model'] }, false)).toBe('改了设定、模型')
    expect(changeSummary({ changedFields: [] }, true)).toBe('创建时的配置')
    expect(changeSummary({ changedFields: [] }, false)).toBe('内容与上一次相同')
  })
})
