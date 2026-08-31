import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  AssetIdSchema,
  buildHostApiContractPath,
  ChannelIdSchema,
  ChannelRuntimeTurnSchema,
  HostApiContracts,
  MessagePartSchema,
} from '../src/index.ts'

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

  it('exposes an unreplied Turn without treating it as a normal completion', () => {
    expect(
      ChannelRuntimeTurnSchema.parse({
        turn: 1,
        state: 'unreplied',
        producedReply: false,
        responseState: 'protocol-failed',
        steps: [],
      }),
    ).toMatchObject({ state: 'unreplied', producedReply: false })
  })

  it('validates path and scalar query parameters before building a transport URL', () => {
    const contract = {
      path: '/api/example/:id',
      params: z
        .object({
          id: z.unknown(),
          text: z.string().optional(),
          count: z.number().optional(),
          enabled: z.boolean().optional(),
          extra: z.unknown().optional(),
        })
        .strict(),
    }
    expect(
      buildHostApiContractPath(contract, {
        id: 'value/with spaces',
        text: 'hello',
        count: 2,
        enabled: true,
      }),
    ).toBe('/api/example/value%2Fwith%20spaces?text=hello&count=2&enabled=true')
    expect(() => buildHostApiContractPath(contract, { id: 1 })).toThrow('path parameter id')
    expect(() => buildHostApiContractPath(contract, { id: 'valid', extra: [] })).toThrow('query parameter extra')
    expect(
      HostApiContracts.createConnection.parseRequest({
        adapterKey: 'fake',
        alias: '   ',
      }),
    ).toEqual({ adapterKey: 'fake', alias: undefined, configuration: {}, credentials: {} })
  })
})
