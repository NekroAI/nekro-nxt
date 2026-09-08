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
      throw new Error('未能确认供应商是否已移除，请重新检查影响以核对结果。', { cause })
    }
    if (isLlmProviderRemoved(settings, provider)) return settings
    throw cause
  }
}
