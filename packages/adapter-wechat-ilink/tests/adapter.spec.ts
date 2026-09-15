import { parseAdapterConnectionConfiguration } from '@nekro-nxt/adapter-sdk'
import { describe, expect, it } from 'vitest'
import { WECHAT_ILINK_CONNECTION_DEFINITION, WECHAT_ILINK_CONNECTION_DESCRIPTOR } from '../src/index.ts'

describe('WeChat iLink Adapter descriptor', () => {
  it('derives configuration defaults, credentials and creator input from one definition', () => {
    const parsed = parseAdapterConnectionConfiguration(WECHAT_ILINK_CONNECTION_DEFINITION, {
      configuration: { enableInboundMedia: false },
      credentials: {},
    })

    expect(parsed).toEqual({
      configuration: {
        enableInboundMedia: false,
      },
      credentials: {},
    })
    expect(WECHAT_ILINK_CONNECTION_DESCRIPTOR).toMatchObject({
      key: 'wechat-ilink',
      displayName: '微信 iLink',
      provisioning: 'user-created',
      aliasEditable: true,
      channelDiscovery: 'adapter-observed',
      channelKinds: ['direct'],
      creation: {
        mode: 'qr-login',
        actionLabel: '扫码登录',
        pendingLabel: '等待扫码确认…',
      },
      configSchema: {
        required: [],
        properties: {
          enableInboundMedia: {
            type: 'boolean',
            title: '入站媒体接收',
            default: true,
          },
        },
      },
    })
    const publicDescriptor = JSON.stringify(WECHAT_ILINK_CONNECTION_DESCRIPTOR)
    expect(publicDescriptor).not.toContain('机器人账号 ID')
    expect(publicDescriptor).not.toContain('访问令牌')
    expect(publicDescriptor).not.toContain('API 地址')
    expect(publicDescriptor).not.toContain('CDN 地址')
    expect(WECHAT_ILINK_CONNECTION_DEFINITION.create(parsed.configuration, parsed.credentials)).toEqual({
      enableInboundMedia: false,
    })
  })
})
