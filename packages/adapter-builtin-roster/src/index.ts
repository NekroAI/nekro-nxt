import { createOneBot11HostContribution } from '@nekro-nxt/adapter-onebot-11'
import { createQQOpenClawHostContribution } from '@nekro-nxt/adapter-qq-openclaw'
import type { AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import { WEB_HOST_CONTRIBUTION } from '@nekro-nxt/adapter-web'
import { createWeComAiBotHostContribution } from '@nekro-nxt/adapter-wecom-ai-bot'
import {
  WECHAT_ILINK_ADAPTER_KEY,
  WechatIlinkConnectionConfigurationSchema,
  WechatIlinkConnectionInputSchema,
  createWechatIlinkHostContribution,
  createWechatIlinkSdkLoginClientFactory,
  type WechatIlinkLoginClientFactory,
  type WechatIlinkTransportFactory,
} from '@nekro-nxt/adapter-wechat-ilink'

export type BuiltinWechatIlinkLoginClientFactory = WechatIlinkLoginClientFactory
export type BuiltinWechatIlinkTransportFactory = WechatIlinkTransportFactory

export interface BuiltinWechatIlinkConnectionConfiguration {
  readonly accountId: string
  readonly baseUrl: string
  readonly cdnBaseUrl: string
  readonly botType: string
  readonly longPollTimeoutMs: number
  readonly channelVersion?: string | undefined
  readonly routeTag?: string | undefined
  readonly enableInboundMedia: boolean
  readonly enableOutboundMedia: boolean
  readonly maxTextLength: number
}

export interface BuiltinWechatIlinkConnectionInput extends BuiltinWechatIlinkConnectionConfiguration {
  readonly botToken: string
}

export const parseBuiltinWechatIlinkConnectionConfiguration = (
  value: unknown,
): BuiltinWechatIlinkConnectionConfiguration => WechatIlinkConnectionConfigurationSchema.parse(value)

export const parseBuiltinWechatIlinkConnectionInput = (value: unknown): BuiltinWechatIlinkConnectionInput =>
  WechatIlinkConnectionInputSchema.parse(value)

export const readBuiltinWechatIlinkInboundMediaSetting = (
  adapterKey: string,
  configuration: unknown,
): boolean | undefined => {
  if (adapterKey !== WECHAT_ILINK_ADAPTER_KEY) return undefined
  const parsed = WechatIlinkConnectionConfigurationSchema.safeParse(configuration)
  return parsed.success ? parsed.data.enableInboundMedia : undefined
}

export const WECHAT_ILINK_BUILTIN = Object.freeze({
  key: WECHAT_ILINK_ADAPTER_KEY,
  createLoginClientFactory: createWechatIlinkSdkLoginClientFactory,
})

export const createBuiltinAdapterContributions = (
  options: {
    readonly wechatIlinkTransportFactory?: BuiltinWechatIlinkTransportFactory
  } = {},
): readonly AdapterHostContributionV2[] =>
  Object.freeze([
    WEB_HOST_CONTRIBUTION,
    createQQOpenClawHostContribution(),
    createOneBot11HostContribution(),
    createWeComAiBotHostContribution(),
    createWechatIlinkHostContribution({
      ...(options.wechatIlinkTransportFactory === undefined
        ? {}
        : { transportFactory: options.wechatIlinkTransportFactory }),
    }),
  ])

/** The only static composition point for first-party Adapter packages. */
export const BUILTIN_ADAPTER_CONTRIBUTIONS = createBuiltinAdapterContributions()
