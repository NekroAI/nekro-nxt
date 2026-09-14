export * from './config.js'
export * from './inbound.js'
export * from './runtime.js'
export * from './transport.js'
export * from './types.js'

import type { AdapterConnectionLoginContribution, AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import {
  WECHAT_ILINK_CONNECTION_DEFINITION,
  WechatIlinkConnectionConfigurationSchema,
  WechatIlinkConnectionInputSchema,
  WechatIlinkRuntimeConfigSchema,
} from './config.js'
import { WechatIlinkRuntime, type WechatIlinkRuntimeOptions } from './runtime.js'
import { createWechatIlinkSdkLoginClientFactory } from './transport.js'
import type { WechatIlinkLoginClientFactory } from './types.js'

const createWechatIlinkConnectionLogin = (
  loginClientFactory: WechatIlinkLoginClientFactory,
): AdapterConnectionLoginContribution => ({
  mode: 'qr-login',
  async start(input) {
    const result = await loginClientFactory().login({
      signal: input.signal,
      onQRCode: input.onQrCode,
      onStatus: (status) => {
        if (status === 'scaned') {
          input.onStatus('scanned', '已扫码，请在平台应用内确认登录。')
          return
        }
        if (status === 'confirmed') {
          input.onStatus('scanned', '已确认登录，正在保存连接。')
          return
        }
        if (status === 'expired') {
          input.onStatus('expired', '二维码已过期，请重新扫码登录。')
          return
        }
        input.onStatus('pending', '请使用平台应用扫码并确认登录。')
      },
    })
    if (!result.connected) throw new Error(result.message || '扫码登录失败。')
    const parsed = WechatIlinkConnectionInputSchema.parse({
      accountId: result.accountId,
      botToken: result.botToken,
      ...(result.baseUrl === undefined ? {} : { baseUrl: result.baseUrl }),
    })
    return {
      accountKey: parsed.accountId,
      configuration: {
        accountId: parsed.accountId,
        baseUrl: parsed.baseUrl,
        cdnBaseUrl: parsed.cdnBaseUrl,
        botType: parsed.botType,
        longPollTimeoutMs: parsed.longPollTimeoutMs,
        enableInboundMedia: parsed.enableInboundMedia,
        enableOutboundMedia: parsed.enableOutboundMedia,
        maxTextLength: parsed.maxTextLength,
        ...(parsed.channelVersion === undefined ? {} : { channelVersion: parsed.channelVersion }),
        ...(parsed.routeTag === undefined ? {} : { routeTag: parsed.routeTag }),
      },
      credentials: { botToken: parsed.botToken },
    }
  },
})

export const createWechatIlinkHostContribution = (
  options?: Pick<WechatIlinkRuntimeOptions, 'transportFactory'> & {
    readonly loginClientFactory?: WechatIlinkLoginClientFactory
  },
): AdapterHostContributionV2 => ({
  apiVersion: 2,
  descriptor: WECHAT_ILINK_CONNECTION_DEFINITION.descriptor,
  connectionLogin: createWechatIlinkConnectionLogin(
    options?.loginClientFactory ?? createWechatIlinkSdkLoginClientFactory(),
  ),
  create: (context, stored) =>
    Promise.resolve(
      new WechatIlinkRuntime({
        context,
        config: WechatIlinkRuntimeConfigSchema.parse({
          ...WechatIlinkConnectionConfigurationSchema.parse(stored.configuration),
          botTokenCredentialRef: stored.credentialRefs['botToken'],
        }),
        ...(options?.transportFactory === undefined ? {} : { transportFactory: options.transportFactory }),
      }),
    ),
})
