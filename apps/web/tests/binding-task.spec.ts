import { describe, expect, it } from 'vitest'
import { ChannelIdSchema, ConnectionIdSchema } from '@nekro-nxt/contracts'
import { listBindingChannels, type TriggerPolicy } from '../src/pages/binding-task.js'
import type { ChannelSummary } from './product-fixture.js'

const webConnection = ConnectionIdSchema.parse('con_web')
const externalConnection = ConnectionIdSchema.parse('con_external')

const channel = (
  id: string,
  connectionId: string,
  agentId = '',
  triggerPolicy: TriggerPolicy = 'always',
): ChannelSummary => ({
  id: ChannelIdSchema.parse(id),
  connectionId: ConnectionIdSchema.parse(connectionId),
  name: id,
  kind: connectionId === webConnection ? 'internal' : 'group',
  connectionName: connectionId === webConnection ? '内置频道' : '官方机器人',
  agentId,
  trigger: triggerPolicy === 'always' ? '始终响应' : '被提及或回复时',
  runtimePhase: 'idle',
  bindings: agentId
    ? [{ id: `${id}:${agentId}`, agentId, triggerPolicy, processingFeedback: 'auto', activityTriggerOverrides: {} }]
    : [],
  unread: 0,
})

const channels = [
  channel('chn_webmain', webConnection, 'agt_one'),
  channel('chn_externalgroup', externalConnection),
  channel('chn_externalother', externalConnection, 'agt_two', 'mentioned-or-replied'),
]

describe('listBindingChannels', () => {
  it('locks to a single channel when the current conversation supplies one', () => {
    expect(listBindingChannels({ channels, channelId: 'chn_externalother' }).map((item) => item.id)).toEqual([
      'chn_externalother',
    ])
  })

  it('keeps the connection workbench on that account’s channels', () => {
    expect(listBindingChannels({ channels, connectionId: externalConnection }).map((item) => item.id)).toEqual([
      'chn_externalgroup',
      'chn_externalother',
    ])
  })

  it('hides channels already owned by the intelligent-agent being configured', () => {
    expect(listBindingChannels({ channels, excludeBoundToAgentId: 'agt_one' }).map((item) => item.id)).toEqual([
      'chn_externalgroup',
      'chn_externalother',
    ])
  })
})
