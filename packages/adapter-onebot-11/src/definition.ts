import { configSchema, defineAdapterConnection, type AdapterOutboundCapabilities } from '@nekro-nxt/adapter-sdk'
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

const ONEBOT_11_PLATFORM_ACTIONS = [
  {
    name: 'like_member',
    title: '点赞',
    description: '为成员点赞',
    risk: 'low' as const,
    channelKinds: ['direct', 'group'] as const,
    parameters: {
      type: 'object' as const,
      properties: {
        memberId: { type: 'string' },
        times: { type: 'number', minimum: 1, maximum: 10 },
      },
      required: ['memberId', 'times'],
    },
  },
  {
    name: 'mute_member',
    title: '禁言',
    description: '禁言成员',
    risk: 'admin' as const,
    channelKinds: ['group'] as const,
    parameters: {
      type: 'object' as const,
      properties: {
        memberId: { type: 'string' },
        seconds: { type: 'number', minimum: 0, maximum: 2592000 },
      },
      required: ['memberId', 'seconds'],
    },
  },
  {
    name: 'kick_member',
    title: '移出',
    description: '移出成员',
    risk: 'admin' as const,
    channelKinds: ['group'] as const,
    parameters: {
      type: 'object' as const,
      properties: {
        memberId: { type: 'string' },
        rejectRejoin: { type: 'boolean' },
      },
      required: ['memberId'],
    },
  },
  {
    name: 'set_member_card',
    title: '设置名片',
    description: '设置成员频道名片',
    risk: 'admin' as const,
    channelKinds: ['group'] as const,
    parameters: {
      type: 'object' as const,
      properties: {
        memberId: { type: 'string' },
        card: { type: 'string' },
      },
      required: ['memberId', 'card'],
    },
  },
  {
    name: 'set_essence_message',
    title: '设为精华',
    description: '设置消息为精华',
    risk: 'admin' as const,
    channelKinds: ['group'] as const,
    parameters: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' },
      },
      required: ['messageId'],
    },
  },
] as const

export const ONEBOT_11_CONNECTION_DEFINITION = defineAdapterConnection({
  key: ONEBOT_11_ADAPTER_KEY,
  displayName: 'OneBot 11',
  description: '连接独立部署的 OneBot 11 协议端',
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct', 'group'],
  platformActions: ONEBOT_11_PLATFORM_ACTIONS,
  rawApi: { description: '直接调用 OneBot 11 API' },
  activities: [
    {
      key: 'member-poked',
      scope: 'channel',
      displayName: '戳一戳',
      description: '有人戳机器人账号时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
      directedAt: 'member',
    },
    {
      key: 'profile-liked',
      scope: 'connection',
      displayName: '资料卡点赞',
      description: '连接账号的资料卡收到点赞。',
      triggerable: false,
    },
    {
      key: 'member-joined',
      scope: 'channel',
      displayName: '成员加入',
      description: '新成员加入频道时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-left',
      scope: 'channel',
      displayName: '成员离开',
      description: '成员退出或被移出频道时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-muted',
      scope: 'channel',
      displayName: '成员被禁言',
      description: '成员被禁言时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-unmuted',
      scope: 'channel',
      displayName: '解除禁言',
      description: '成员解除禁言时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-admin-set',
      scope: 'channel',
      displayName: '设为管理员',
      description: '成员成为管理员时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-admin-unset',
      scope: 'channel',
      displayName: '取消管理员',
      description: '成员不再是管理员时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-card-changed',
      scope: 'channel',
      displayName: '成员名片变化',
      description: '成员的频道名片变化时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'member-title-changed',
      scope: 'channel',
      displayName: '成员头衔变化',
      description: '成员头衔变化时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'channel-name-changed',
      scope: 'channel',
      displayName: '频道名称变化',
      description: '频道名称变化时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'message-recalled',
      scope: 'channel',
      displayName: '消息撤回',
      description: '频道消息被撤回时允许触发智能体。',
      triggerable: true,
      channelKinds: ['direct', 'group'],
    },
    {
      key: 'message-reaction-added',
      scope: 'channel',
      displayName: '添加消息回应',
      description: '机器人账号的消息收到新的回应时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
      directedAt: 'message',
    },
    {
      key: 'message-reaction-removed',
      scope: 'channel',
      displayName: '移除消息回应',
      description: '机器人账号的消息被移除回应时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
      directedAt: 'message',
    },
    {
      key: 'file-uploaded',
      scope: 'channel',
      displayName: '文件上传',
      description: '频道中上传文件时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'essence-added',
      scope: 'channel',
      displayName: '设为精华',
      description: '消息被设为精华时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'essence-removed',
      scope: 'channel',
      displayName: '取消精华',
      description: '消息被取消精华时允许触发智能体。',
      triggerable: true,
      channelKinds: ['group'],
    },
    {
      key: 'friend-added',
      scope: 'connection',
      displayName: '新增好友',
      description: '连接账号新增好友。',
      triggerable: false,
    },
  ],
  features: { processingFeedback: { channelKinds: ['group'] } },
  diagnostics: { receive: true, send: true },
  configurationSchema: OneBot11ConnectionConfigurationSchema,
  credentialsSchema: OneBot11CredentialsSchema,
  configSchema: configSchema.object({
    endpoint: configSchema.string('WebSocket Endpoint', {
      required: true,
      hint: '协议端提供的正向 Universal WebSocket 地址，保留完整路径。',
    }),
    accessToken: configSchema.secret('Access Token', { hint: '可选。以 Authorization: Bearer 头发送。' }),
    capturePokeEvents: configSchema.boolean('记录戳一戳事件', { default: true, advanced: true }),
    captureMessageReactionEvents: configSchema.boolean('记录普通消息回应', { default: false, advanced: true }),
  }),
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
