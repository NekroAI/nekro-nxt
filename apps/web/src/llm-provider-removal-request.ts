import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'

type ProviderSettings = HostApiResponse<'llmProviders'>

export const isLlmProviderRemoved = (settings: ProviderSettings, provider: string): boolean =>
  !settings.providers.some((entry) => entry.provider === provider && entry.configured)

/** Reconciliation only reads: an uncertain DELETE must never be retried automatically. */
export async function removeLlmProviderAndReconcile(
  provider: string,
  expectedRevision: number,
): Promise<ProviderSettings> {
  try {
    return await callHostApi(HostApiContracts.llmRemoveProvider, { provider }, { expectedRevision })
  } catch (cause) {
    let settings: ProviderSettings
    try {
      settings = await callHostApi(HostApiContracts.llmProviders, {}, undefined)
    } catch {
      throw new Error('不确定供应商是否已移除，请刷新后查看。', { cause })
    }
    if (isLlmProviderRemoved(settings, provider)) return settings
    throw cause
  }
}
