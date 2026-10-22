import {
  DEFAULT_MODEL_FALLBACK_SETTINGS,
  ModelFallbackSettingsSchema,
  type ModelFallbackSettings,
} from '@nekro-nxt/contracts'
import type { MessagePacingSettingsStore } from './message-pacing.js'

const SETTING_KEY = 'llm.modelFallback'

/** How long failed models are passed over; a stored value from another version that no longer parses is the default. */
export const readModelFallbackSettings = (settings: Pick<MessagePacingSettingsStore, 'get'>): ModelFallbackSettings => {
  const parsed = ModelFallbackSettingsSchema.safeParse(settings.get(SETTING_KEY)?.value)
  return parsed.success ? parsed.data : DEFAULT_MODEL_FALLBACK_SETTINGS
}

export const writeModelFallbackSettings = (
  settings: MessagePacingSettingsStore,
  value: ModelFallbackSettings,
): ModelFallbackSettings => {
  const parsed = ModelFallbackSettingsSchema.parse(value)
  settings.put(SETTING_KEY, { ...parsed }, settings.get(SETTING_KEY)?.revision)
  return parsed
}
