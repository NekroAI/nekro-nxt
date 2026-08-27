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
  LogicalMessageIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'

export const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
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
  const imported: Uint8Array[] = []
  let remoteBytes = new Uint8Array([1])
  let channelSequence = 0
  let memberSequence = 0
  const context: AdapterConnectionHostContext = {
    connectionId: ConnectionIdSchema.parse('con_WECOMTEST'),
    now: () => Date.now(),
    acceptInbound: (event) => {
      events.push(event)
      return Promise.resolve({ channelEventId: ChannelEventIdSchema.parse(`evt_${events.length}`), inserted: true })
    },
    channels: {
      ensure: ({ platformChannelId }) => {
        const current = channels.get(platformChannelId)
        if (current) return Promise.resolve(current)
        const id = ChannelIdSchema.parse(`chn_WECOM${++channelSequence}`)
        channels.set(platformChannelId, id)
        return Promise.resolve(id)
      },
      updateDisplayName: () => Promise.resolve(),
      resolvePlatformChannelId: (channelId) =>
        Promise.resolve([...channels].find(([, candidate]) => candidate === channelId)?.[0]),
      resolveKind: (channelId) => {
        const platform = [...channels].find(([, candidate]) => candidate === channelId)?.[0]
        return Promise.resolve(platform?.startsWith('group:') ? 'group' : platform ? 'direct' : undefined)
      },
    },
    members: {
      ensure: ({ channelId, platformUserId }) => {
        const key = `${channelId}:${platformUserId}`
        const current = members.get(key)
        if (current) return Promise.resolve(current)
        const id = ChannelMemberIdSchema.parse(`mbr_WECOM${++memberSequence}`)
        members.set(key, id)
        return Promise.resolve(id)
      },
      resolvePlatformUserId: () => Promise.resolve(undefined),
    },
    messages: {
      resolvePlatformMessage: () => Promise.resolve(undefined),
      resolvePlatformMessageId: () => Promise.resolve(undefined),
      resolveLogicalMessage: (_channelId, logicalMessageId) =>
        Promise.resolve(
          LogicalMessageIdSchema.safeParse(logicalMessageId).success ? { authoredByAgent: true } : undefined,
        ),
    },
    assets: {
      importBytes: ({ bytes, declaredMediaType }) => {
        imported.push(bytes)
        return Promise.resolve({
          assetId: AssetIdSchema.parse(`ast_WECOM${imported.length}`),
          mediaType: declaredMediaType ?? 'application/octet-stream',
          byteSize: bytes.byteLength,
        })
      },
      read: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', byteSize: 3 }),
      fetchRemoteBytes: () =>
        Promise.resolve({ bytes: remoteBytes, declaredMediaType: 'image/png', filename: 'fixture.png' }),
    },
    credentials: { resolve: () => Promise.resolve('fixture-secret') },
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
    diagnostics: { publish: (diagnostic) => diagnostics.push(diagnostic) },
  }
  return {
    context,
    events,
    diagnostics,
    states,
    channels,
    imported,
    setRemoteBytes: (bytes: Uint8Array) => {
      remoteBytes = new Uint8Array(bytes)
    },
  }
}
