import { HostApiContracts } from '../src/host-api.ts'
import { describe, expect, it } from 'vitest'

const provider = {
  provider: 'example-gateway',
  displayName: '示例网关',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'example-gateway'],
  settingsRevision: 1,
  declared: false,
  active: true,
  configured: true,
  models: [{ id: 'example-model', name: 'Example Model' }],
  modelsCustomized: false,
  discoverable: true,
}

const settings = (entry: Record<string, unknown>) => ({ writable: true, protocols: [], providers: [entry] })

describe('LLM provider connection test result', () => {
  it('stays optional for hosts that do not record tests and accepts an untested configuration', () => {
    expect(HostApiContracts.llmProviders.parseResponse(settings(provider)).providers[0]).not.toHaveProperty('lastTest')
    expect(HostApiContracts.llmProviders.parseResponse(settings({ ...provider, lastTest: null })).providers[0]).toEqual(
      {
        ...provider,
        lastTest: null,
      },
    )
  })

  it('carries the time, outcome, a short reason and the tested model only', () => {
    const failed = { at: 1_700_000_000_000, ok: false, message: '认证失败，请更新 API 密钥。', model: 'example-model' }
    expect(
      HostApiContracts.llmProviders.parseResponse(settings({ ...provider, lastTest: failed })).providers[0]?.lastTest,
    ).toEqual(failed)
    expect(() =>
      HostApiContracts.llmProviders.parseResponse(
        settings({ ...provider, lastTest: { ...failed, apiKey: 'synthetic-key' } }),
      ),
    ).toThrow()
    expect(() =>
      HostApiContracts.llmProviders.parseResponse(
        settings({ ...provider, lastTest: { ...failed, message: 'x'.repeat(241) } }),
      ),
    ).toThrow()
  })
})
