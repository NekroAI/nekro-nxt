import type { AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  QQOpenClawRuntime,
  type QQGatewayCheckpoint,
  type QQGatewaySocket,
  type QQOpenClawTransport,
} from '../src/index.ts'

const connectionId = ConnectionIdSchema.parse('con_runtime')
const channelId = ChannelIdSchema.parse('chn_runtime')

const socketFrom = (payloads: readonly unknown[]): QQGatewaySocket => ({
  messages: {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () => {
          const payload = payloads[index++]
          return Promise.resolve(
            payload === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value: JSON.stringify(payload) },
          )
        },
      }
    },
  },
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
})

describe('QQ OpenClaw composed runtime', () => {
  it('decodes Gateway media, commits the Channel fact, saves resume state and stops quiescently', async () => {
    let resumeState: QQGatewayCheckpoint | undefined
    let accepted: AdapterInboundEvent | undefined
    let resolveAccepted: (() => void) | undefined
    const acceptedPromise = new Promise<void>((resolve) => {
      resolveAccepted = resolve
    })
    let transportStops = 0
    const transport: QQOpenClawTransport = {
      start: () => Promise.resolve(),
      stop: () => {
        transportStops += 1
        return Promise.resolve()
      },
      sendText: () => Promise.reject(new Error('not used')),
      upload: () => Promise.reject(new Error('not used')),
      sendMedia: () => Promise.reject(new Error('not used')),
    }
    const runtime = new QQOpenClawRuntime({
      context: {
        connectionId,
        now: () => 1_000,
        acceptInbound: (event) => {
          accepted = event
          resolveAccepted?.()
          return Promise.resolve({
            channelEventId: ChannelEventIdSchema.parse('evt_runtime'),
            inserted: true,
          })
        },
      },
      config: {
        appId: 'app',
        clientSecretCredentialRef: 'credential:qq',
        proactiveSend: false,
        markdown: true,
        maxTextLength: 100,
        maxAssetBytes: 1024,
        passiveReplyTtlMs: 1000,
        passiveReplyLimit: 2,
      },
      directory: {
        resolveTarget: () => Promise.resolve(undefined),
        resolveMemberOpenId: () => Promise.resolve(undefined),
        resolvePlatformMessageId: () => Promise.resolve(undefined),
      },
      assets: { read: () => Promise.reject(new Error('not used')) },
      inbound: {
        ensureTarget: () => Promise.resolve(channelId),
        ensureMember: ({ openId }) => Promise.resolve(ChannelMemberIdSchema.parse(`mbr_${openId.replaceAll('-', '')}`)),
        importAttachment: ({ fileName, mediaType }) =>
          Promise.resolve({
            assetId: AssetIdSchema.parse('ast_video'),
            mediaType: mediaType ?? 'application/octet-stream',
            ...(fileName === undefined ? {} : { fileName }),
          }),
        resolveQuote: () => Promise.resolve(undefined),
      },
      transport,
      gateway: {
        access: {
          gatewayUrl: () => Promise.resolve('wss://gateway.test'),
          accessToken: () => Promise.resolve('token'),
        },
        sockets: {
          connect: () =>
            Promise.resolve(
              socketFrom([
                { op: 10, d: { heartbeat_interval: 45_000 } },
                { op: 0, t: 'READY', s: 1, d: { session_id: 'session-runtime' } },
                {
                  op: 0,
                  t: 'GROUP_MESSAGE_CREATE',
                  s: 2,
                  d: {
                    id: 'qq-runtime-message',
                    group_openid: 'group-openid',
                    author: { member_openid: 'sender-openid' },
                    attachments: [{ url: 'https://cdn.test/video.mp4', content_type: 'video/mp4' }],
                    timestamp: 1,
                  },
                },
                { op: 7 },
              ]),
            ),
        },
        checkpoints: {
          load: () => Promise.resolve(resumeState),
          save: (value) => {
            resumeState = value
            return Promise.resolve()
          },
          clear: () => {
            resumeState = undefined
            return Promise.resolve()
          },
        },
        clock: {
          now: () => 1_000,
          sleep: (_delay, signal) =>
            new Promise<void>((_resolve, reject) => {
              const abortError = (): Error =>
                signal.reason instanceof Error ? signal.reason : new Error('Gateway test aborted.')
              if (signal.aborted) reject(abortError())
              else signal.addEventListener('abort', () => reject(abortError()), { once: true })
            }),
          setInterval: () => () => {},
        },
      },
    })
    await runtime.start()
    await acceptedPromise
    await runtime.stop()
    expect(accepted).toMatchObject({
      platformSequence: 2,
      parts: [{ type: 'file', assetId: 'ast_video' }],
      facts: { mentionedBot: false, replyToBot: false, targetKind: 'group' },
    })
    expect(resumeState).toMatchObject({ sessionId: 'session-runtime', sequence: 2 })
    expect(transportStops).toBe(1)
  })
})
