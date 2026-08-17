import { describe, expect, it } from 'vitest'
import { providerDisplayName } from '../src/provider-labels.js'

describe('providerDisplayName', () => {
  it('projects common DSH provider keys as product labels', () => {
    expect(providerDisplayName('deepseek', 'deepseek')).toBe('DeepSeek')
    expect(providerDisplayName('azure-openai-responses', 'azure-openai-responses')).toBe('Azure OpenAI Responses')
    expect(providerDisplayName('github-copilot', 'github-copilot')).toBe('GitHub Copilot')
  })

  it('preserves an explicit upstream or custom display name', () => {
    expect(providerDisplayName('team-gateway', '研发模型网关')).toBe('研发模型网关')
  })

  it('turns an unknown key into a readable fallback instead of leaking a slug', () => {
    expect(providerDisplayName('future-ai-provider')).toBe('Future AI Provider')
  })
})
