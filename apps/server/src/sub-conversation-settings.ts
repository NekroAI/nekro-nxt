import {
  DEFAULT_SUB_CONVERSATION_RETENTION,
  SubConversationRetentionSchema,
  type SubConversationRetention,
} from '@nekro-nxt/contracts'
import type { MessagePacingSettingsStore } from './message-pacing.js'

const SETTING_KEY = 'conversation.subConversations'

export const readSubConversationRetention = (
  settings: Pick<MessagePacingSettingsStore, 'get'>,
): SubConversationRetention => {
  const value = settings.get(SETTING_KEY)?.value
  const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? value['retention'] : undefined
  const parsed = SubConversationRetentionSchema.safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_SUB_CONVERSATION_RETENTION
}

export const writeSubConversationRetention = (
  settings: MessagePacingSettingsStore,
  retention: SubConversationRetention,
): SubConversationRetention => {
  settings.put(SETTING_KEY, { retention }, settings.get(SETTING_KEY)?.revision)
  return retention
}
