import type {
  AdapterConnectionDiagnostic,
  AdapterConnectionHostContext,
  AdapterConnectionInboundEvent,
  AdapterChannelInboundEvent,
} from '@nekro-nxt/adapter-sdk'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  ConnectionEventIdSchema,
  PlatformIdentityIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { FakeAdapterTransport } from '@nekro-nxt/test-harness'

export const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const createFakeContext = () => {
  const events: AdapterChannelInboundEvent[] = []
  const connectionEvents: AdapterConnectionInboundEvent[] = []
  const diagnostics: AdapterConnectionDiagnostic[] = []
  const states = new Map<string, JsonValue>()
  const channels = new Map<string, ReturnType<typeof ChannelIdSchema.parse>>()
  const identities = new Map<string, ReturnType<typeof PlatformIdentityIdSchema.parse>>()
  const members = new Map<string, ReturnType<typeof ChannelMemberIdSchema.parse>>()
  const selfMembers = new Set<string>()
  const accountReports: string[] = []
  let channelSequence = 0
  let identitySequence = 0
  let memberSequence = 0
  const context: AdapterConnectionHostContext = {
    connectionId: ConnectionIdSchema.parse('con_TEST1'),
    now: () => Date.now(),
    acceptChannelInbound: (event) => {
      events.push(event)
      return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse(`evt_${events.length}`), inserted: true })
    },
    acceptConnectionInbound: (event) => {
      connectionEvents.push(event)
      return Promise.resolve({
        connectionEventId: ConnectionEventIdSchema.parse(`cev_${connectionEvents.length}`),
        inserted: true,
      })
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
    identities: {
      ensure: (input) => {
        const existing = identities.get(input.platformUserId)
        if (existing) return Promise.resolve(existing)
        const id = PlatformIdentityIdSchema.parse(`pid_${++identitySequence}`)
        identities.set(input.platformUserId, id)
        return Promise.resolve(id)
      },
    },
    members: {
      ensure: (input) => {
        const key = `${input.channelId}:${input.platformUserId}`
        const id = members.get(key) ?? ChannelMemberIdSchema.parse(`mbr_${++memberSequence}`)
        members.set(key, id)
        if (input.self === true) selfMembers.add(id)
        return Promise.resolve(id)
      },
      resolvePlatformUserId: (channelId, memberId) =>
        Promise.resolve(
          [...members]
            .find(([key, candidate]) => key.startsWith(`${channelId}:`) && candidate === memberId)?.[0]
            .split(':')
            .at(-1),
        ),
      isSelf: (_channelId, memberId) => Promise.resolve(selfMembers.has(memberId)),
    },
    account: {
      report: ({ platformUserId }) => {
        accountReports.push(platformUserId)
        return Promise.resolve()
      },
    },
    messages: {
      resolvePlatformMessage: () => Promise.resolve(undefined),
      resolvePlatformMessageId: () => Promise.resolve(undefined),
      resolveLogicalMessage: () => Promise.resolve(undefined),
    },
    assets: {
      importBytes: ({ bytes }) =>
        Promise.resolve({
          assetId: AssetIdSchema.parse('ast_TEST1'),
          mediaType: 'image/png',
          byteSize: bytes.byteLength,
        }),
      read: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', byteSize: 3 }),
      fetchRemoteBytes: () => Promise.resolve({ bytes: new Uint8Array([4, 5, 6]), declaredMediaType: 'image/png' }),
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
    transport: new FakeAdapterTransport(),
  }
  return {
    context,
    events,
    connectionEvents,
    diagnostics,
    states,
    channels,
    identities,
    members,
    selfMembers,
    accountReports,
  }
}
