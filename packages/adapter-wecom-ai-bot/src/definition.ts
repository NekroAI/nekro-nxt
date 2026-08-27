import { defineAdapterConnection, type AdapterOutboundCapabilities } from '@nekro-nxt/adapter-sdk'
import { z } from 'zod'

export const WECOM_AI_BOT_ADAPTER_KEY = 'wecom-ai-bot'
export const WECOM_AI_BOT_ENDPOINT = 'wss://openws.work.weixin.qq.com'

export const WeComAiBotConnectionConfigurationSchema = z.object({ botId: z.string().trim().min(1) }).strict()
export const WeComAiBotCredentialsSchema = z.object({ secret: z.string().trim().min(1) }).strict()
export const WeComAiBotRuntimeConfigSchema = WeComAiBotConnectionConfigurationSchema.extend({
  secretCredentialRef: z.string().trim().min(1),
}).strict()

export type WeComAiBotRuntimeConfig = z.output<typeof WeComAiBotRuntimeConfigSchema>

export const WECOM_AI_BOT_CONNECTION_DEFINITION = defineAdapterConnection({
  key: WECOM_AI_BOT_ADAPTER_KEY,
  displayName: '企业微信智能机器人',
  description: '连接企业微信官方智能机器人长连接',
  userCreatable: true,
  configurationSchema: WeComAiBotConnectionConfigurationSchema,
  credentialsSchema: WeComAiBotCredentialsSchema,
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['botId', 'secret'],
    properties: {
      botId: { type: 'string', title: 'BotID', description: '企业微信智能机器人配置页提供的 BotID。' },
      secret: {
        type: 'credential-reference',
        title: 'Secret',
        description: '开启长连接 API 模式后提供的专用 Secret。',
      },
    },
  },
  create: (configuration, credentials) => ({ ...configuration, secret: credentials.secret }),
})

export const WECOM_AI_BOT_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  images: true,
  files: true,
  audio: true,
  mentions: false,
  replies: false,
  mixedContent: false,
  proactiveSend: true,
  maxAssetBytes: 20 * 1024 * 1024,
}
