import { describe, expect, it } from 'vitest'
import {
  parseAdapterCapabilities,
  parseAdapterConnectionConfiguration,
  parseAdapterInboundEvent,
  type AdapterConnectionDescriptor,
} from '../src/index.ts'

describe('Adapter wire contracts', () => {
  it('accepts a normalized inbound file event without inventing a video type', () => {
    expect(
      parseAdapterInboundEvent({
        connectionId: 'connection-1',
        channelId: 'channel-1',
        adapterKey: 'fake',
        platformEventId: 'event-1',
        kind: 'message-created',
        parts: [{ type: 'file', assetId: 'asset-video', name: 'clip.mp4' }],
        platformTimestamp: 10,
        receivedAt: 11,
        dedupeKey: 'event:event-1',
      }).parts,
    ).toEqual([{ type: 'file', assetId: 'asset-video', name: 'clip.mp4' }])
  })

  it('rejects missing dedupe facts and invalid limits', () => {
    expect(() =>
      parseAdapterInboundEvent({
        connectionId: 'connection-1',
        channelId: 'channel-1',
        adapterKey: 'fake',
        kind: 'message-created',
        parts: [{ type: 'text', text: 'hello' }],
        platformTimestamp: 10,
        receivedAt: 11,
      }),
    ).toThrow()
    expect(() =>
      parseAdapterCapabilities({
        text: true,
        mentions: true,
        images: true,
        files: true,
        audio: true,
        replies: true,
        mixedContent: true,
        proactiveSend: true,
        maxTextLength: 0,
      }),
    ).toThrow()
  })

  it('separates write-only credentials from durable Adapter configuration', () => {
    const descriptor: AdapterConnectionDescriptor = {
      key: 'example',
      displayName: 'Example',
      description: 'Example platform',
      userCreatable: true,
      configSchema: {
        schemaVersion: 1,
        type: 'object',
        required: ['account', 'secretRef'],
        properties: {
          account: { type: 'string', title: '账号' },
          secretRef: { type: 'credential-reference', title: '密钥' },
          enabled: { type: 'boolean', title: '启用', default: true },
        },
      },
    }
    expect(
      parseAdapterConnectionConfiguration(descriptor, {
        configuration: { account: ' account-1 ' },
        credentials: { secretRef: 'secret-value' },
      }),
    ).toEqual({
      configuration: { account: 'account-1', enabled: true },
      credentials: { secretRef: 'secret-value' },
    })
    expect(() =>
      parseAdapterConnectionConfiguration(descriptor, {
        configuration: { account: 'account-1', secretRef: 'must-not-enter-config' },
      }),
    ).toThrow('请填写密钥')
  })
})
