import { z } from 'zod'

export const ADAPTER_DYNAMIC_EVIDENCE_METHOD = '__nekro_nxt_adapter_evidence_v1'

export const AdapterDynamicEvidenceSchema = z
  .object({
    apiVersion: z.literal(1),
    descriptor: z
      .object({
        key: z.string().trim().min(1),
        displayName: z.string().trim().min(1),
      })
      .passthrough(),
    registered: z.literal(true),
    started: z.boolean(),
    stopped: z.boolean(),
    credentialIsolated: z.boolean(),
    inboundCommitted: z.boolean(),
    channelDiscovered: z.boolean(),
    outboundReceipt: z.enum(['sent', 'failed', 'unknown']),
    transportIdle: z.boolean(),
  })
  .strict()

const ADAPTER_DYNAMIC_HARNESS_SOURCE = String.raw`
const __nxtAdapterRegistrations = []
harness.registerAdapter = (contribution) => {
  if (__nxtAdapterRegistrations.length > 0) throw new Error('one Adapter Revision can register only one contribution')
  if (!contribution || contribution.apiVersion !== 1 || typeof contribution.create !== 'function') {
    throw new Error('harness.registerAdapter requires AdapterHostContributionV1')
  }
  const descriptor = JSON.parse(JSON.stringify(contribution.descriptor))
  const validation = (async () => {
    const channels = new Map()
    const members = new Map()
    const states = new Map()
    const diagnostics = []
    const sockets = []
    const credentialsResolved = []
    let inboundCommitted = false
    let channelSequence = 0
    let memberSequence = 0
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {}, throwIfAborted() {} }
    const context = {
      connectionId: 'con_VALIDATE',
      now: () => 1,
      acceptInbound: async () => {
        inboundCommitted = true
        return { channelEventId: 'evt_VALIDATE', inserted: true }
      },
      channels: {
        ensure: async (input) => {
          if (!channels.has(input.platformChannelId)) channels.set(input.platformChannelId, 'chn_VALIDATE' + (++channelSequence))
          return channels.get(input.platformChannelId)
        },
        updateDisplayName: async () => {},
        resolvePlatformChannelId: async (channelId) => [...channels].find((entry) => entry[1] === channelId)?.[0],
        resolveKind: async () => 'group'
      },
      members: {
        ensure: async (input) => {
          const key = input.channelId + ':' + input.platformUserId
          if (!members.has(key)) members.set(key, 'mbr_VALIDATE' + (++memberSequence))
          return members.get(key)
        },
        resolvePlatformUserId: async () => 'user-example'
      },
      messages: {
        resolvePlatformMessage: async () => undefined,
        resolvePlatformMessageId: async () => undefined,
        resolveLogicalMessage: async () => undefined
      },
      assets: {
        importBytes: async (input) => ({ assetId: 'ast_VALIDATE', mediaType: input.declaredMediaType || 'application/octet-stream', byteSize: input.bytes.byteLength }),
        read: async () => ({ bytes: new Uint8Array([1]), mediaType: 'application/octet-stream', byteSize: 1 }),
        fetchRemoteBytes: async () => ({ bytes: new Uint8Array([1]), declaredMediaType: 'application/octet-stream', filename: 'fixture.bin' })
      },
      credentials: {
        resolve: async (reference) => {
          credentialsResolved.push(reference)
          return 'synthetic-secret'
        }
      },
      state: {
        load: async (key) => states.get(key),
        save: async (key, value) => { states.set(key, value) },
        clear: async (key) => { states.delete(key) }
      },
      diagnostics: { publish: (diagnostic) => diagnostics.push(diagnostic) },
      transport: {
        request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
        connectWebSocket: async () => {
          const listeners = new Set()
          const socket = {
            closed: false,
            send: async () => {},
            close: async () => {
              if (socket.closed) return
              socket.closed = true
              for (const listener of listeners) listener({ type: 'close', code: 1000, reason: 'validation complete' })
              listeners.clear()
            },
            subscribe: (listener) => {
              listeners.add(listener)
              Promise.resolve().then(() => listener({ type: 'open' }))
              return () => listeners.delete(listener)
            },
            listenerCount: () => listeners.size
          }
          sockets.push(socket)
          return socket
        }
      }
    }
    const configuration = {}
    const credentialRefs = {}
    for (const [key, property] of Object.entries(descriptor.configSchema.properties)) {
      if (property.type === 'credential-reference') {
        credentialRefs[property.credentialKey || key] = 'cred_' + key
      } else if (property.type === 'string') configuration[key] = property.default === undefined ? 'example' : property.default
      else if (property.type === 'number') configuration[key] = property.default === undefined ? 1 : property.default
      else if (property.type === 'boolean') configuration[key] = property.default === undefined ? false : property.default
    }
    const credentialIsolated = Object.values(configuration).every((value) => value !== 'synthetic-secret') &&
      Object.values(credentialRefs).every((value) => typeof value === 'string' && value.startsWith('cred_'))
    const runtime = await contribution.create(context, { configuration, credentialRefs })
    let started = false
    let stopped = false
    let outboundReceipt = 'unknown'
    try {
      await runtime.start()
      started = true
      await Promise.resolve()
      const channelId = [...channels.values()][0] || await context.channels.ensure({ platformChannelId: 'channel-example', kind: 'group', observedAt: 1 })
      const receipt = await runtime.deliver({
        deliveryId: 'phy_VALIDATE',
        logicalMessageId: 'msg_VALIDATE',
        connectionId: context.connectionId,
        channelId,
        parts: [{ type: 'text', text: 'synthetic validation' }]
      }, signal)
      outboundReceipt = receipt.status
    } finally {
      await runtime.stop()
      stopped = true
    }
    return {
      apiVersion: 1,
      descriptor,
      registered: true,
      started,
      stopped,
      credentialIsolated,
      inboundCommitted,
      channelDiscovered: channels.size > 0,
      outboundReceipt,
      transportIdle: sockets.every((socket) => socket.closed && socket.listenerCount() === 0)
    }
  })()
  __nxtAdapterRegistrations.push({ contribution, validation })
  harness.handle('${ADAPTER_DYNAMIC_EVIDENCE_METHOD}', async () => await validation)
  return () => {}
}
`

/** Compatibility fallback for Packages defined through the upstream cordis_define tool. */
export const isLegacyAdapterDynamicHostSource = (source: string | undefined): source is string =>
  source?.includes('harness.registerAdapter(') === true

export const wrapAdapterDynamicHostSource = (source: string): string => `${ADAPTER_DYNAMIC_HARNESS_SOURCE}\n${source}`
