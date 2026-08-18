import { z } from 'zod'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  defineAdapterConnection,
  parseAdapterCapabilities,
  parseAdapterConnectionConfiguration,
  parseAdapterInboundEvent,
} from '../src/index.ts'

const ExampleConfigurationSchema = z
  .object({
    account: z.string().trim().min(1),
    enabled: z.boolean().default(true),
  })
  .strict()

const ExampleCredentialsSchema = z
  .object({
    secretRef: z.string().trim().min(1),
  })
  .strict()

const EXAMPLE_CONNECTION_DEFINITION = defineAdapterConnection({
  key: 'example',
  displayName: 'Example',
  description: 'Example platform',
  userCreatable: true,
  configurationSchema: ExampleConfigurationSchema,
  credentialsSchema: ExampleCredentialsSchema,
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['account', 'secretRef'],
    properties: {
      account: { type: 'string', title: '账号' },
      secretRef: { type: 'credential-reference', title: '密钥' },
      enabled: { type: 'boolean', title: '启用', default: true },
    },
  },
  create: (configuration, credentials) => ({
    ...configuration,
    secretRef: credentials.secretRef,
  }),
})

type ExampleConfiguration = z.output<typeof ExampleConfigurationSchema>
type ExampleCredentials = z.output<typeof ExampleCredentialsSchema>

describe('Adapter wire contracts', () => {
  it('accepts a normalized inbound file event without inventing a video type', () => {
    expect(
      parseAdapterInboundEvent({
        connectionId: 'con_1',
        channelId: 'chn_1',
        adapterKey: 'fake',
        platformEventId: 'event-1',
        kind: 'message-created',
        parts: [{ type: 'file', assetId: 'ast_video', name: 'clip.mp4' }],
        platformTimestamp: 10,
        receivedAt: 11,
        dedupeKey: 'event:event-1',
      }).parts,
    ).toEqual([{ type: 'file', assetId: 'ast_video', name: 'clip.mp4' }])
    expect(
      parseAdapterInboundEvent({
        connectionId: 'con_1',
        channelId: 'chn_1',
        adapterKey: 'fake',
        platformEventId: 'event-empty',
        kind: 'message-created',
        parts: [],
        platformTimestamp: 10,
        receivedAt: 11,
        dedupeKey: 'event:event-empty',
      }).parts,
    ).toEqual([])
  })

  it('rejects missing dedupe facts and invalid limits', () => {
    expect(() =>
      parseAdapterInboundEvent({
        connectionId: 'con_1',
        channelId: 'chn_1',
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

  it('derives exact configuration and credential outputs for the creator', () => {
    const parsed = parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
      configuration: { account: ' account-1 ' },
      credentials: { secretRef: 'secret-value' },
    })
    expectTypeOf(parsed.configuration).toEqualTypeOf<ExampleConfiguration>()
    expectTypeOf(parsed.credentials).toEqualTypeOf<ExampleCredentials>()
    expectTypeOf(EXAMPLE_CONNECTION_DEFINITION.create).parameter(0).toEqualTypeOf<ExampleConfiguration>()
    expectTypeOf(EXAMPLE_CONNECTION_DEFINITION.create).parameter(1).toEqualTypeOf<ExampleCredentials>()
    expect(parsed).toEqual({
      configuration: { account: 'account-1', enabled: true },
      credentials: { secretRef: 'secret-value' },
    })
    expect(EXAMPLE_CONNECTION_DEFINITION.create(parsed.configuration, parsed.credentials)).toEqual({
      account: 'account-1',
      enabled: true,
      secretRef: 'secret-value',
    })
  })

  it('rejects unknown, missing, and incorrectly typed configuration or credentials', () => {
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        configuration: { account: ' account-1 ' },
        credentials: { secretRef: 'secret-value', unexpected: 'value' },
      }),
    ).toThrow('未知字段')
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        configuration: { account: 'account-1', unexpected: true },
      }),
    ).toThrow('未知字段')
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        configuration: { account: 'account-1', secretRef: 'must-stay-out-of-configuration' },
        credentials: { secretRef: 'secret-value' },
      }),
    ).toThrow('未知字段')
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        credentials: { secretRef: 'secret-value' },
      }),
    ).toThrow()
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        configuration: { account: 'account-1', enabled: 'true' },
        credentials: { secretRef: 'secret-value' },
      }),
    ).toThrow()
    expect(() =>
      parseAdapterConnectionConfiguration(EXAMPLE_CONNECTION_DEFINITION, {
        configuration: { account: 'account-1' },
        credentials: { secretRef: 123 },
      }),
    ).toThrow()
  })
})
