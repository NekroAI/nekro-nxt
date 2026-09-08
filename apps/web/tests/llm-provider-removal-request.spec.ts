import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { removeLlmProviderAndReconcile } from '../src/llm-provider-removal-request.js'

const provider = 'synthetic-gateway'
const entry = {
  provider,
  displayName: '测试供应商',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', provider],
  settingsRevision: 3,
  declared: true,
  configured: true,
  active: true,
  models: [],
}
const settings = (providers: HostApiResponse<'llmProviders'>['providers']): HostApiResponse<'llmProviders'> => ({
  writable: true,
  protocols: [],
  providers,
})
const response = (body: unknown, status = 200) => Response.json(body, { status })

afterEach(() => vi.unstubAllGlobals())

describe('provider removal response reconciliation', () => {
  it.each([
    ['custom entry missing', settings([])],
    ['catalog entry unconfigured', settings([{ ...entry, declared: false, configured: false, active: false }])],
  ])('accepts a lost response when %s, without retrying DELETE', async (_, after) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('synthetic lost response'))
      .mockResolvedValueOnce(response(after))
    vi.stubGlobal('fetch', fetch)
    await expect(removeLlmProviderAndReconcile(provider, 2)).resolves.toEqual(after)
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(['DELETE', 'GET'])
  })

  it('reconciles a post-commit 503 and an invalid success body', async () => {
    for (const failedResponse of [
      response({ error: { code: 'result-read-failed', message: '已提交但读取失败' } }, 503),
      response({ invalid: true }),
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(failedResponse)
        .mockResolvedValueOnce(response(settings([])))
      vi.stubGlobal('fetch', fetch)
      await expect(removeLlmProviderAndReconcile(provider, 2)).resolves.toEqual(settings([]))
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  })

  it('keeps a conflict rejected when the provider is still configured', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ error: { code: 'conflict', message: '供应商配置已变化' } }, 409))
      .mockResolvedValueOnce(response(settings([entry])))
    vi.stubGlobal('fetch', fetch)
    await expect(removeLlmProviderAndReconcile(provider, 2)).rejects.toMatchObject({
      status: 409,
      commitState: 'rejected',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not claim success or retry when reconciliation also fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('synthetic offline'))
    vi.stubGlobal('fetch', fetch)
    await expect(removeLlmProviderAndReconcile(provider, 2)).rejects.toThrow('未能确认供应商是否已移除')
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(['DELETE', 'GET'])
  })
})
