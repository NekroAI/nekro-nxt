import { describe, expect, it } from 'vitest'
import { AgentIdSchema, AssetIdSchema, ChannelIdSchema, HostApiContracts, MessagePartSchema } from '../src/index.ts'

describe('public ID boundaries', () => {
  it('keeps brands separated by their runtime prefixes', () => {
    expect(AgentIdSchema.parse('agt_ABC123')).toBe('agt_ABC123')
    expect(ChannelIdSchema.parse('chn_ABC123')).toBe('chn_ABC123')
    expect(AssetIdSchema.parse('ast_ABC123')).toBe('ast_ABC123')
    expect(() => AgentIdSchema.parse('chn_ABC123')).toThrow('AgentId')
    expect(() => ChannelIdSchema.parse('agt_ABC123')).toThrow('ChannelId')
    expect(() => AssetIdSchema.parse('../asset')).toThrow('AssetId')
  })

  it('rejects the wrong ID brand inside message and HTTP contracts', () => {
    expect(() => MessagePartSchema.parse({ type: 'image', assetId: 'chn_NOTANASSET' })).toThrow()
    expect(() =>
      HostApiContracts.createBinding.parseRequest({
        agentId: 'chn_NOTANAGENT',
        channelId: 'chn_CHANNEL',
        triggerPolicy: 'always',
      }),
    ).toThrow()
  })
})
