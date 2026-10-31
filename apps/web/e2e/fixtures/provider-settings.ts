import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'

/**
 * Journeys run in parallel against one Host, and every model provider lives in one settings namespace. A write
 * carries the revision it read, so another journey's write in between rejects it; read again and retry.
 */
export async function retryOnSettingsConflict(attempt: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let tries = 0; tries < 5; tries += 1) {
    const response = await attempt()
    if (response.ok() || !(await response.text()).includes('changed since it was read')) return response
  }
  throw new Error('模型供应商设置连续五次在写入前被其他旅程改动。')
}

export const providerSettings = async (request: APIRequestContext) => {
  const response = await request.get('/api/llm/providers')
  expect(response.ok()).toBe(true)
  return HostApiContracts.llmProviders.parseResponse(await response.json())
}

/** The current revision a write to `provider` must carry. */
export const providerRevision = async (request: APIRequestContext, provider: string): Promise<number> => {
  const { providers } = await providerSettings(request)
  const entry =
    providers.find((item) => item.provider === provider) ?? providers.find((item) => item.settingsNs === 'llm-pi-ai')
  return entry?.settingsRevision ?? 0
}

/** Saves a provider with a revision read just before each attempt. */
export const saveProvider = (
  request: APIRequestContext,
  provider: string,
  data: Readonly<Record<string, unknown>>,
): Promise<APIResponse> =>
  retryOnSettingsConflict(async () =>
    request.post(`/api/llm/providers/${provider}`, {
      data: { ...data, expectedRevision: await providerRevision(request, provider) },
    }),
  )

/** Removes a provider after a fresh removal preview on each attempt. */
export const removeProvider = (request: APIRequestContext, provider: string): Promise<APIResponse> =>
  retryOnSettingsConflict(async () => {
    const impact = HostApiContracts.llmProviderRemovalImpact.parseResponse(
      await (await request.get(`/api/llm/providers/${provider}/removal-impact`)).json(),
    )
    return request.delete(`/api/llm/providers/${provider}`, { data: { expectedRevision: impact.expectedRevision } })
  })
