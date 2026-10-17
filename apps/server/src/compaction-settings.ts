import {
  CompactionSettingsSchema,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { MessagePacingSettingsStore } from './message-pacing.js'

const SETTING_KEY = 'channel.compaction'

/** The host's compaction defaults; a stored value from another version that no longer parses reads as the default. */
export const readCompactionSettings = (settings: Pick<MessagePacingSettingsStore, 'get'>): CompactionSettings => {
  const parsed = CompactionSettingsSchema.safeParse(settings.get(SETTING_KEY)?.value)
  return parsed.success ? parsed.data : DEFAULT_COMPACTION_SETTINGS
}

export const writeCompactionSettings = (
  settings: MessagePacingSettingsStore,
  value: CompactionSettings,
): CompactionSettings => {
  const parsed = CompactionSettingsSchema.parse(value)
  const model = parsed.newSessionModel
  const stored: JsonValue = {
    timeoutSeconds: parsed.timeoutSeconds,
    newSessionModel:
      model.mode === 'main'
        ? { mode: 'main' }
        : {
            mode: 'custom',
            model: {
              provider: model.model.provider,
              model: model.model.model,
              ...(model.model.reasoningEffort === undefined ? {} : { reasoningEffort: model.model.reasoningEffort }),
            },
          },
  }
  settings.put(SETTING_KEY, stored, settings.get(SETTING_KEY)?.revision)
  return parsed
}
