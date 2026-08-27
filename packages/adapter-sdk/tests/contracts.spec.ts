import { z } from 'zod'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AdapterRegistry,
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

describe('AdapterRegistry', () => {
  const contribution = {
    apiVersion: 1 as const,
    descriptor: {
      key: 'fixture-adapter',
      displayName: 'Fixture Adapter',
      description: 'Synthetic registry fixture.',
      userCreatable: true,
      aliasEditable: true,
      channelDiscovery: 'adapter-observed' as const,
      diagnostics: { receive: true, send: true },
      configSchema: { schemaVersion: 1, type: 'object' as const, required: [], properties: {} },
    },
    create: () => Promise.reject(new Error('not used')),
  }

  it('owns a stable key and releases it through an idempotent handle', async () => {
    const registry = new AdapterRegistry()
    const handle = registry.register('fixture-revision', contribution)
    expect(registry.get('fixture-adapter')).toBe(contribution)
    expect(registry.list()).toEqual([contribution])
    expect(() => registry.register('other-revision', contribution)).toThrow('already registered')
    expect(() =>
      registry.register('fixture-revision', {
        ...contribution,
        descriptor: { ...contribution.descriptor, key: 'other' },
      }),
    ).toThrow('owner is already registered')
    await handle.dispose()
    await handle.dispose()
    expect(registry.list()).toEqual([])
    expect(registry.register('other-revision', contribution).contribution).toBe(contribution)
  })

  it('derives non-user-creatable descriptor defaults', () => {
    const definition = defineAdapterConnection({
      key: 'managed',
      displayName: 'Managed',
      description: 'System-managed fixture.',
      userCreatable: false,
      configurationSchema: z.object({}).strict(),
      credentialsSchema: z.object({}).strict(),
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
      create: () => undefined,
    })
    expect(definition.descriptor).toMatchObject({
      aliasEditable: false,
      channelDiscovery: 'host-created',
      diagnostics: { receive: false, send: false },
    })
  })

  it('rejects every malformed owner, API version, and descriptor boundary', () => {
    const register = (descriptor: unknown, owner = 'invalid-fixture', apiVersion: number = 1) => {
      const registry = new AdapterRegistry()
      Reflect.apply(registry.register.bind(registry), undefined, [
        owner,
        { apiVersion, descriptor, create: () => Promise.reject(new Error('not used')) },
      ])
    }
    const descriptor = contribution.descriptor

    expect(() => register(descriptor, ' ')).toThrow('owner must not be empty')
    expect(() => register(descriptor, 'invalid-version', 2)).toThrow('Unsupported Adapter Host API version')
    expect(() => register({ ...descriptor, key: '' })).toThrow('key must not be empty')
    expect(() => register({ ...descriptor, key: 'X' })).toThrow('lowercase letters')
    expect(() => register({ ...descriptor, displayName: ' ' })).toThrow('displayName must not be empty')
    expect(() => register({ ...descriptor, configSchema: { ...descriptor.configSchema, type: 'array' } })).toThrow(
      'schema must be an object',
    )
    expect(() =>
      register({ ...descriptor, configSchema: { ...descriptor.configSchema, schemaVersion: Number.NaN } }),
    ).toThrow('version must be a positive integer')
    expect(() => register({ ...descriptor, configSchema: { ...descriptor.configSchema, schemaVersion: 0 } })).toThrow(
      'version must be a positive integer',
    )
    expect(() =>
      register({
        ...descriptor,
        configSchema: { ...descriptor.configSchema, required: ['account', 'account'] },
      }),
    ).toThrow('required property is duplicated')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          properties: { '': { type: 'string', title: 'Account' } },
        },
      }),
    ).toThrow('stable keys and titles')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          properties: { account: { type: 'string', title: ' ' } },
        },
      }),
    ).toThrow('stable keys and titles')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          properties: { secret: { type: 'credential-reference', title: 'Secret', default: 'forbidden' } },
        },
      }),
    ).toThrow('cannot declare a default')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          properties: { enabled: { type: 'boolean', title: 'Enabled', default: 'true' } },
        },
      }),
    ).toThrow('default has the wrong type')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          properties: {
            first: { type: 'credential-reference', title: 'First', credentialKey: 'shared' },
            second: { type: 'credential-reference', title: 'Second', credentialKey: 'shared' },
          },
        },
      }),
    ).toThrow('credential key is duplicated')
    expect(() =>
      register({
        ...descriptor,
        configSchema: {
          ...descriptor.configSchema,
          required: ['missing'],
          properties: { secret: { type: 'credential-reference', title: 'Secret' } },
        },
      }),
    ).toThrow('required property is not declared')

    const registry = new AdapterRegistry()
    registry.register('fixture-owner', contribution)
    expect(registry.getByOwner('fixture-owner')).toBe(contribution)
    expect(registry.getByOwner('missing-owner')).toBeUndefined()
  })
})
