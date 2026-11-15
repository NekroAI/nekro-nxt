import {
  AgentIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  ExtensionIdSchema,
  LogicalMessageIdSchema,
  PlatformIdentityIdSchema,
  type ExtensionCapabilities,
} from '@nekro-nxt/contracts'
import type { ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import type { BindingRecord, ChannelEventRecord, ChannelRecord } from '@nekro-nxt/core'
import type { Revision } from '@nekro-nxt/extension-runtime'
import type { NxtInboundMessage } from '@nekro-nxt/extension-sdk'
import { describe, expect, it } from 'vitest'
import { createNxtProductBackends, type NxtProductFacts } from '../src/extension-host-backends.js'
import { createNxtHostService, type NxtServiceBinding } from '../src/extension-host-service.js'
import { ExtensionInboundHookGate } from '../src/extension-inbound-hooks.js'
import type { PersistentInboundHandler } from '../src/persistent-extension-mounts.js'
import { unusedNxtBackends } from './fixtures/unused-nxt-backends.js'

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the code under test reads only the fields given.
const partial = <T>(value: Partial<T>): T => value as T

const channelId = ChannelIdSchema.parse('chn_members')
const alice = ChannelMemberIdSchema.parse('mbr_alice')
const agentId = AgentIdSchema.parse('agt_members')
const platformIds: Readonly<Record<string, string>> = { [alice]: '10001' }

const inbound: ChannelHistoryEntry = {
  source: 'channel-event',
  sourceId: ChannelEventIdSchema.parse('evt_hello'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_hello'),
  channelId,
  occurredAt: 5,
  senderMemberId: alice,
  parts: [{ type: 'text', text: '帮我查一下积分' }],
}

const event: ChannelEventRecord = {
  id: ChannelEventIdSchema.parse('evt_hello'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_hello'),
  channelId,
  kind: 'message-created',
  senderMemberId: alice,
  parts: [{ type: 'text', text: '帮我查一下积分' }],
  sourceTimestamp: 5,
  receivedAt: 5,
  dedupeKey: 'hello',
  searchText: '帮我查一下积分',
}

const facts: NxtProductFacts = {
  history: partial<NxtProductFacts['history']>({
    getChannel: () =>
      partial<ChannelRecord>({ id: channelId, connectionId: ConnectionIdSchema.parse('con_alpha'), kind: 'group' }),
    getChannelMember: (id) =>
      id === alice
        ? { id, channelId, platformIdentityId: PlatformIdentityIdSchema.parse('pid_alice'), displayName: '小林' }
        : undefined,
    listChannelHistory: () => [inbound],
    searchChannelHistory: () => [{ entry: inbound, rank: 1 }],
  }),
  getConnectionName: () => '示例连接',
  getAgentName: () => '示例智能体',
  createAsset: () => Promise.reject(new Error('not used')),
  resolveCredential: () => Promise.reject(new Error('not used')),
  turnTrigger: () => ({ event, senderMemberId: alice, requester: { kind: 'member', memberId: alice } }),
  memberPlatformUserId: (memberId) => platformIds[memberId],
}

const backends = createNxtProductBackends(facts, unusedNxtBackends())

const binding = (capabilities: ExtensionCapabilities): NxtServiceBinding => ({
  mode: 'activation',
  agentId,
  ownerKey: ExtensionIdSchema.parse('ext_MEMBERSFIXTURE00000000000'),
  displayName: '积分',
  channelId,
  episodeId: () => 'eps_hello',
  capabilities: () => capabilities,
  config: () => ({}),
  declaredSecrets: () => ({ config: [], hostConfig: [] }),
})

/** Every member summary the extension can reach in this channel. */
const summaries = async (capabilities: ExtensionCapabilities) => {
  const nxt = createNxtHostService(binding(capabilities), backends)
  const context = await nxt.context.current()
  return [
    context.latestInbound?.sender,
    context.trigger?.sender,
    await nxt.members.describe(alice),
    (await nxt.history.list()).messages[0]?.sender,
    (await nxt.history.search('积分'))[0]?.sender,
  ]
}

describe('members.platformUserId', () => {
  it('adds the platform account to every member summary of an extension that declares it', async () => {
    const seen = await summaries({ history: { read: true }, members: { platformUserId: true } })
    expect(seen).toHaveLength(5)
    for (const sender of seen) {
      expect(sender).toEqual({ memberId: alice, displayName: '小林', platformUserId: '10001' })
    }
  })

  it('leaves the field out, not empty, for an extension without it', async () => {
    const seen = await summaries({ history: { read: true } })
    expect(seen).toHaveLength(5)
    for (const sender of seen) {
      expect(sender).toEqual({ memberId: alice, displayName: '小林' })
      expect(sender).not.toHaveProperty('platformUserId')
    }
  })

  it('gives the sender of an inbound message the account only for handlers that declare it', async () => {
    const received = new Map<string, NxtInboundMessage>()
    const handler = (name: string): PersistentInboundHandler => ({
      agentId,
      revision: partial<Revision>({ extensionId: ExtensionIdSchema.parse(`ext_${name.padEnd(26, '0')}`) }),
      config: {},
      hostConfig: {},
      handler: (message) => {
        received.set(name, message)
        return undefined
      },
    })
    const hook = { inboundHook: { reads: 'all', mayHide: false, mayForceTrigger: false, timeoutMs: 1000 } } as const
    const gate = new ExtensionInboundHookGate({
      handlers: () => [handler('PLAIN'), handler('ACCOUNTS')],
      describe: (entry) => ({
        displayName: '示例',
        capabilities: entry.revision.extensionId.includes('ACCOUNTS')
          ? { ...hook, members: { platformUserId: true } }
          : hook,
      }),
      nxtFor: () => createNxtHostService(binding({}), backends),
      message: (record, wouldTrigger, detail) => ({
        logicalMessageId: record.logicalMessageId,
        channel: { id: record.channelId, kind: 'group' },
        sender: {
          memberId: alice,
          ...(detail.platformUserId ? { platformUserId: platformIds[alice] ?? '' } : {}),
        },
        text: '帮我查一下积分',
        images: [],
        mentionsAgent: false,
        wouldTrigger,
        receivedAt: record.receivedAt,
      }),
      store: { get: () => undefined, save: ({ decision }) => decision },
      now: () => 6,
    })
    await gate.decide({
      binding: partial<BindingRecord>({ agentId, channelId }),
      event,
      defaultTriggered: true,
    })
    expect(received.get('PLAIN')?.sender).toEqual({ memberId: alice })
    expect(received.get('ACCOUNTS')?.sender).toEqual({ memberId: alice, platformUserId: '10001' })
  })
})
