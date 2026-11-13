import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, isChatModelId, presetByKey, presetForBaseURL } from '../src/provider-presets.js'

describe('provider presets', () => {
  it('leads with the recommended relay', () => {
    expect(PROVIDER_PRESETS[0]?.label).toBe('NekroAPI')
    expect(PROVIDER_PRESETS[0]?.recommended).toBe(true)
    expect(presetByKey(PROVIDER_PRESETS[0]!.key)?.baseURL).toBe('https://api.nekro.ai/v1')
  })

  it('puts Claude on its own Anthropic-protocol entry right after the recommended one', () => {
    expect(PROVIDER_PRESETS[1]).toMatchObject({
      label: 'NekroAPI · Claude',
      api: 'anthropic-messages',
      baseURL: 'https://api.nekro.ai',
      recommended: false,
    })
  })

  it('splits models between the two entries and drops the nocache twins from Claude', () => {
    const [openai, claude] = PROVIDER_PRESETS
    expect(openai!.offers('gpt-5')).toBe(true)
    expect(openai!.offers('claude-sonnet-4-5')).toBe(false)
    expect(claude!.offers('claude-sonnet-4-5')).toBe(true)
    expect(claude!.offers('claude-sonnet-4-5-nocache')).toBe(false)
    expect(claude!.offers('gpt-5')).toBe(false)
    expect(claude!.offers('claude-image-x')).toBe(false)
  })

  it('recognises a route by its address', () => {
    expect(presetForBaseURL('https://api.nekro.ai/v1')?.label).toBe('NekroAPI')
    expect(presetForBaseURL('https://api.nekro.ai/v1/')?.label).toBe('NekroAPI')
    expect(presetForBaseURL('https://api.nekro.ai')?.label).toBe('NekroAPI · Claude')
    expect(presetForBaseURL('https://api.openai.com/v1')).toBeUndefined()
    expect(presetForBaseURL('not a url')).toBeUndefined()
    expect(presetForBaseURL(undefined)).toBeUndefined()
  })

  it.each([
    'gpt-image-2',
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'gemini-nano-banana-2.1',
    'doubao-seedream-5-0-260128',
    'grok-imagine-image-2.0',
    'text-embedding-3-large',
    'bge-reranker-v2-m3',
    'jina-rerank-v2',
    'tts-1',
    'whisper-1',
  ])('drops non-chat model %s', (id) => {
    expect(isChatModelId(id)).toBe(false)
  })

  it.each(['gpt-5', 'claude-sonnet-4-5', 'gemini-3-pro', 'deepseek-chat', 'doubao-seed-1-6', 'grok-4'])(
    'keeps chat model %s',
    (id) => {
      expect(isChatModelId(id)).toBe(true)
    },
  )
})
