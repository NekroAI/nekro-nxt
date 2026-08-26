import { defineAdapterConnection, type AdapterOutboundCapabilities } from '@nekro-nxt/adapter-sdk'
import { z } from 'zod'

export const ONEBOT_11_ADAPTER_KEY = 'onebot-11'

const OneBotEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      return ['ws:', 'wss:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'Endpoint 必须是 ws:// 或 wss:// 地址。')

export const OneBot11ConnectionConfigurationSchema = z
  .object({
    endpoint: OneBotEndpointSchema,
    capturePokeEvents: z.boolean().default(true),
    captureMessageReactionEvents: z.boolean().default(false),
  })
  .strict()

export const OneBot11CredentialsSchema = z.object({ accessToken: z.string().trim().min(1).optional() }).strict()

export const OneBot11RuntimeConfigSchema = OneBot11ConnectionConfigurationSchema.extend({
  accessTokenCredentialRef: z.string().trim().min(1).optional(),
}).strict()

export type OneBot11RuntimeConfig = z.output<typeof OneBot11RuntimeConfigSchema>

export const ONEBOT_11_CONNECTION_DEFINITION = defineAdapterConnection({
  key: ONEBOT_11_ADAPTER_KEY,
  displayName: 'OneBot 11',
  description: '连接独立部署的 OneBot 11 协议端',
  userCreatable: true,
  configurationSchema: OneBot11ConnectionConfigurationSchema,
  credentialsSchema: OneBot11CredentialsSchema,
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['endpoint'],
    properties: {
      endpoint: {
        type: 'string',
        title: 'WebSocket Endpoint',
        description: '协议端提供的正向 Universal WebSocket 地址，保留完整路径。',
      },
      accessToken: {
        type: 'credential-reference',
        title: 'Access Token',
        description: '可选。以 Authorization: Bearer 头发送。',
      },
      capturePokeEvents: { type: 'boolean', title: '记录戳一戳事件', default: true },
      captureMessageReactionEvents: { type: 'boolean', title: '记录普通消息回应', default: false },
    },
  },
  create: (configuration, credentials) => ({ ...configuration, accessToken: credentials.accessToken }),
})

export const ONEBOT_11_CONNECTION_DESCRIPTOR = ONEBOT_11_CONNECTION_DEFINITION.descriptor

export const ONEBOT_11_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  images: true,
  audio: true,
  mentions: true,
  replies: true,
  mixedContent: true,
  proactiveSend: true,
  files: false,
  maxAssetBytes: 20 * 1024 * 1024,
}
