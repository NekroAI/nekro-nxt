import { AdapterEmptyObjectSchema, defineAdapterConnection } from '@nekro-nxt/adapter-sdk'
import { z } from 'zod'
import { WECHAT_ILINK_ADAPTER_KEY } from './types.js'

export const WechatIlinkPublicConfigurationSchema = z
  .object({
    enableInboundMedia: z.boolean().default(true),
  })
  .strict()

export const WechatIlinkConnectionConfigurationSchema = WechatIlinkPublicConfigurationSchema.extend({
  accountId: z.string().trim().min(1),
  baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
  cdnBaseUrl: z.string().url().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  botType: z.string().trim().min(1).default('3'),
  longPollTimeoutMs: z.number().int().positive().default(30_000),
  channelVersion: z.string().trim().min(1).optional(),
  routeTag: z.string().trim().min(1).optional(),
  enableOutboundMedia: z.boolean().default(false),
  maxTextLength: z.number().int().positive().max(4000).default(4000),
}).strict()

export const WechatIlinkCredentialsSchema = z
  .object({
    botTokenCredentialRef: z.string().trim().min(1),
  })
  .strict()

export const WechatIlinkConnectionInputSchema = WechatIlinkConnectionConfigurationSchema.extend({
  botToken: z.string().trim().min(1),
}).strict()

export const WechatIlinkRuntimeConfigSchema = WechatIlinkConnectionConfigurationSchema.extend({
  ...WechatIlinkCredentialsSchema.shape,
}).strict()

export type WechatIlinkConnectionInput = z.input<typeof WechatIlinkConnectionInputSchema>
export type WechatIlinkRuntimeConfig = z.input<typeof WechatIlinkRuntimeConfigSchema>
export type WechatIlinkStoredConfig = z.output<typeof WechatIlinkConnectionConfigurationSchema>

export const WECHAT_ILINK_CONNECTION_DEFINITION = defineAdapterConnection({
  key: WECHAT_ILINK_ADAPTER_KEY,
  displayName: '微信 iLink',
  description: '连接实验性微信 iLink 通道，支持私聊文本与入站媒体，出站仅支持已收到消息后的文本回复',
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct'],
  activities: [],
  diagnostics: { receive: true, send: true },
  creation: {
    mode: 'qr-login',
    actionLabel: '扫码登录',
    pendingLabel: '等待扫码确认…',
  },
  configurationSchema: WechatIlinkPublicConfigurationSchema,
  credentialsSchema: AdapterEmptyObjectSchema,
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: [],
    properties: {
      enableInboundMedia: {
        type: 'boolean',
        title: '入站媒体接收',
        description: '开启后，微信 iLink 收到的图片和文件会下载并导入为频道资源。',
        default: true,
      },
    },
  },
  create: (configuration) => configuration,
})

export const WECHAT_ILINK_CONFIG_SCHEMA = WECHAT_ILINK_CONNECTION_DEFINITION.descriptor.configSchema
export const WECHAT_ILINK_CONNECTION_DESCRIPTOR = WECHAT_ILINK_CONNECTION_DEFINITION.descriptor
