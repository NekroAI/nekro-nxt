import { configSchema, defineAdapterConnection, type AdapterOutboundCapabilities } from '@nekro-nxt/adapter-sdk'
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
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct', 'group'],
  activities: [
    {
      key: 'conversation-entered',
      scope: 'channel',
      displayName: '进入会话',
      description: '成员进入机器人会话时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct'],
    },
    {
      key: 'card-action-invoked',
      scope: 'channel',
      displayName: '卡片操作',
      description: '成员操作交互式卡片时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
    },
    {
      key: 'message-feedback-positive',
      scope: 'channel',
      displayName: '正向反馈',
      description: '成员认可一条回复时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
    },
    {
      key: 'message-feedback-negative',
      scope: 'channel',
      displayName: '负向反馈',
      description: '成员反馈回复不准确时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
    },
    {
      key: 'message-feedback-withdrawn',
      scope: 'channel',
      displayName: '撤销反馈',
      description: '成员撤销回复反馈时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
    },
  ],
  features: { processingFeedback: { channelKinds: ['group'] } },
  diagnostics: { receive: true, send: true },
  configurationSchema: WeComAiBotConnectionConfigurationSchema,
  credentialsSchema: WeComAiBotCredentialsSchema,
  configSchema: configSchema.object({
    botId: configSchema.string('BotID', { required: true, hint: '企业微信智能机器人配置页提供的 BotID。' }),
    secret: configSchema.secret('Secret', { required: true, hint: '开启长连接 API 模式后提供的专用 Secret。' }),
  }),
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
