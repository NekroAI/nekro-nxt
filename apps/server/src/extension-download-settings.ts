import { EXTENSION_DOWNLOAD_MAX_BYTES, ExtensionDownloadSettingsSchema } from '@nekro-nxt/contracts'
import type { MessagePacingSettingsStore } from './message-pacing.js'

const SETTING_KEY = 'extension.downloadLimit'

/** 扩展下载上限; a stored value from another version that no longer parses is the default. */
export const readExtensionDownloadLimit = (settings: Pick<MessagePacingSettingsStore, 'get'>): number => {
  const parsed = ExtensionDownloadSettingsSchema.safeParse(settings.get(SETTING_KEY)?.value)
  return parsed.success ? parsed.data.maxBytes : EXTENSION_DOWNLOAD_MAX_BYTES
}

export const writeExtensionDownloadLimit = (settings: MessagePacingSettingsStore, maxBytes: number): number => {
  const parsed = ExtensionDownloadSettingsSchema.parse({ maxBytes })
  settings.put(SETTING_KEY, { ...parsed }, settings.get(SETTING_KEY)?.revision)
  return parsed.maxBytes
}
