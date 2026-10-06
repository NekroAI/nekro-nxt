import { describe, expect, it } from 'vitest'
import { missingAgentModel, replacementModel } from '../src/app/agents/model-health.js'

const models = [
  { provider: 'fixture-provider', id: 'fixture-text', inputModalities: ['text'] },
  { provider: 'fixture-provider', id: 'fixture-vision', inputModalities: ['text', 'image'] },
  { provider: 'other-provider', id: 'other-vision', inputModalities: ['text', 'image'] },
] as const

describe('agent model health', () => {
  it('reports the saved model only when its provider no longer lists it', () => {
    expect(missingAgentModel({ modelRef: { provider: 'fixture-provider', model: 'fixture-retired' } }, models)).toEqual(
      {
        provider: 'fixture-provider',
        model: 'fixture-retired',
      },
    )
    expect(missingAgentModel({ modelRef: { provider: 'fixture-provider', model: 'fixture-text' } }, models)).toBe(
      undefined,
    )
    expect(missingAgentModel({}, models)).toBe(undefined)
  })

  it('suggests a same-provider replacement that understands images first', () => {
    expect(replacementModel({ provider: 'fixture-provider' }, models)?.id).toBe('fixture-vision')
    expect(replacementModel({ provider: 'fixture-provider' }, models.slice(0, 1))?.id).toBe('fixture-text')
    expect(replacementModel({ provider: 'missing-provider' }, models)).toBe(undefined)
  })
})
