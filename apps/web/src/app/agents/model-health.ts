import type { AgentSummary, ModelSummary } from '../../product-runtime.js'

/**
 * The saved default model when its provider no longer lists it (for example a retired model name). The agent may
 * still run, but its image capability can no longer be confirmed.
 */
export const missingAgentModel = (
  agent: Pick<AgentSummary, 'modelRef'>,
  models: readonly Pick<ModelSummary, 'provider' | 'id'>[],
): { readonly provider: string; readonly model: string } | undefined => {
  const ref = agent.modelRef
  if (!ref) return undefined
  return models.some((model) => model.provider === ref.provider && model.id === ref.model) ? undefined : ref
}

/** A model from the same provider to switch to, preferring one that understands images. */
export const replacementModel = <Model extends Pick<ModelSummary, 'provider' | 'inputModalities'>>(
  missing: { readonly provider: string },
  models: readonly Model[],
): Model | undefined =>
  models.find((model) => model.provider === missing.provider && model.inputModalities?.includes('image') === true) ??
  models.find((model) => model.provider === missing.provider)
