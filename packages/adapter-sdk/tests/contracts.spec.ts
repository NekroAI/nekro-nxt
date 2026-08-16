import { describe, expect, it } from 'vitest'
import { parseAdapterCapabilities, parseAdapterInboundEvent } from '../src/index.ts'

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
})
