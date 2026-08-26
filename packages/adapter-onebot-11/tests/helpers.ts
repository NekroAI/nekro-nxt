import type {
  AdapterConnectionDiagnostic,
  AdapterConnectionHostContext,
  AdapterInboundEvent,
} from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'

export const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const createFakeContext = () => {
  const events: AdapterInboundEvent[] = []
  const diagnostics: AdapterConnectionDiagnostic[] = []
  const states = new Map<string, JsonValue>()
  const channels = new Map<string, ReturnType<typeof ChannelIdSchema.parse>>()
  const members = new Map<string, ReturnType<typeof ChannelMemberIdSchema.parse>>()
  let channelSequence = 0
  let memberSequence = 0
  const context: AdapterConnectionHostContext = {
    connectionId: ConnectionIdSchema.parse('con_TEST1'),
    now: () => Date.now(),
    acceptInbound: (event) => {
      events.push(event)
      return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse(`evt_${events.length}`), inserted: true })
    },
    channels: {
      ensure: (input) => {
        const existing = channels.get(input.platformChannelId)
        if (existing) return Promise.resolve(existing)
        const id = ChannelIdSchema.parse(`chn_${++channelSequence}`)
        channels.set(input.platformChannelId, id)
        return Promise.resolve(id)
      },
      updateDisplayName: () => Promise.resolve(),
      resolvePlatformChannelId: (channelId) =>
        Promise.resolve([...channels].find(([, candidate]) => candidate === channelId)?.[0]),
      resolveKind: (channelId) => {
        const platform = [...channels].find(([, candidate]) => candidate === channelId)?.[0]
        return Promise.resolve(
          platform?.startsWith('group:') ? 'group' : platform?.startsWith('private:') ? 'direct' : undefined,
        )
      },
    },
    members: {
      ensure: (input) => {
        const key = `${input.channelId}:${input.platformUserId}`
        const existing = members.get(key)
        if (existing) return Promise.resolve(existing)
        const id = ChannelMemberIdSchema.parse(`mbr_${++memberSequence}`)
        members.set(key, id)
        return Promise.resolve(id)
      },
      resolvePlatformUserId: (channelId, memberId) =>
        Promise.resolve(
          [...members]
            .find(([key, candidate]) => key.startsWith(`${channelId}:`) && candidate === memberId)?.[0]
            .split(':')
            .at(-1),
        ),
    },
    messages: {
      resolvePlatformMessage: () => Promise.resolve(undefined),
      resolvePlatformMessageId: () => Promise.resolve(undefined),
    },
    assets: {
      importBytes: ({ bytes }) =>
        Promise.resolve({
          assetId: AssetIdSchema.parse('ast_TEST1'),
          mediaType: 'image/png',
          byteSize: bytes.byteLength,
        }),
      read: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', byteSize: 3 }),
    },
    credentials: { resolve: () => Promise.resolve('test-token') },
    state: {
      load: (key) => Promise.resolve(states.get(key)),
      save: (key, value) => {
        states.set(key, value)
        return Promise.resolve()
      },
      clear: (key) => {
        states.delete(key)
        return Promise.resolve()
      },
    },
    diagnostics: {
      publish: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
    },
  }
  return { context, events, diagnostics, states, channels, members }
}
