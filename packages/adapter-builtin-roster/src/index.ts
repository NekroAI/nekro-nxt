import { createOneBot11HostContribution } from '@nekro-nxt/adapter-onebot-11'
import { createQQOpenClawHostContribution } from '@nekro-nxt/adapter-qq-openclaw'
import type { AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import { WEB_HOST_CONTRIBUTION } from '@nekro-nxt/adapter-web'
import { createWeComAiBotHostContribution } from '@nekro-nxt/adapter-wecom-ai-bot'
import {
  createWechatIlinkHostContribution,
  createWechatIlinkSdkLoginClientFactory,
  type WechatIlinkLoginClientFactory,
  type WechatIlinkTransportFactory,
} from '@nekro-nxt/adapter-wechat-ilink'

export type BuiltinWechatIlinkLoginClientFactory = WechatIlinkLoginClientFactory
export type BuiltinWechatIlinkTransportFactory = WechatIlinkTransportFactory

export const createBuiltinAdapterContributions = (
  options: {
    readonly wechatIlinkTransportFactory?: BuiltinWechatIlinkTransportFactory
    readonly wechatIlinkLoginClientFactory?: BuiltinWechatIlinkLoginClientFactory
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
      ...(options.wechatIlinkLoginClientFactory === undefined
        ? { loginClientFactory: createWechatIlinkSdkLoginClientFactory() }
        : { loginClientFactory: options.wechatIlinkLoginClientFactory }),
    }),
  ])

/** The only static composition point for first-party Adapter packages. */
export const BUILTIN_ADAPTER_CONTRIBUTIONS = createBuiltinAdapterContributions()
