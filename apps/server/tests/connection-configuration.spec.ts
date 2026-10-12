import type { AdapterConnectionHostContext, AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import { configSchema } from '@nekro-nxt/contracts'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'

async function fixture(required = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-connection-edit-'))
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extensions'),
    extensionCacheRoot: path.join(directory, 'cache'),
  })
  const mounted: Array<{ endpoint: unknown; token?: string | undefined }> = []
  const faults = { stop: false }
  let context: AdapterConnectionHostContext | undefined
  const contribution: AdapterHostContributionV2 = {
    apiVersion: 2,
    descriptor: {
      key: 'fixture-edit',
      displayName: '虚构平台',
      description: 'Synthetic editable connection',
      provisioning: 'user-created',
      aliasEditable: true,
      channelDiscovery: 'adapter-observed',
      channelKinds: ['group'],
      activities: [],
      features: {},
      diagnostics: { receive: true, send: true },
      configSchema: configSchema.object({
        endpoint: configSchema.string('地址', { required: true }),
        enabled: configSchema.boolean('记录事件', { default: true }),
        token: configSchema.secret('访问凭据', { required }),
        auxiliary: configSchema.secret('备用凭据'),
      }),
    },
    create: (host, input) => {
      context = host
      return Promise.resolve({
        capabilities: {
          outbound: {
            text: true,
            mentions: false,
            images: false,
            files: false,
            audio: false,
            replies: false,
            mixedContent: false,
            proactiveSend: true,
          },
          activities: {},
        },
        start: async () => {
          if (input.configuration['endpoint'] === 'refused') throw new Error('虚构平台拒绝连接。')
          mounted.push({
            endpoint: input.configuration['endpoint'],
            token: input.credentialRefs['token']
              ? await host.credentials.resolve(input.credentialRefs['token'])
              : undefined,
          })
          host.diagnostics.publish({ status: 'connected' })
        },
        stop: () => (faults.stop ? Promise.reject(new Error('synthetic stop failed')) : Promise.resolve()),
        deliver: () => Promise.resolve({ status: 'sent' as const }),
      })
    },
  }
  await runtime.start()
  await runtime.registerAdapter('test:fixture-edit', contribution)
  const connection = await runtime.createConnection({
    adapterKey: contribution.descriptor.key,
    configuration: { endpoint: 'initial', enabled: true },
    credentials: { token: 'fictional-original' },
  })
  const channel = runtime.core.ensureChannel({
    connectionId: connection.id,
    platformChannelId: 'synthetic-channel',
    kind: 'group',
    displayName: '虚构频道',
    observedAt: 1,
  })
  await context!.account.report({ platformUserId: 'synthetic-account', observedAt: 1 })
  const identity = runtime.core.connectionAccountPlatformUserId(connection.id)
  return {
    directory,
    runtime,
    connection,
    channel,
    identity,
    mounted,
    faults,
    async close() {
      faults.stop = false
      vi.restoreAllMocks()
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe('editing existing connection settings', () => {
  it('waits for credential staging during disposal and does not commit after shutdown starts', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
      const save = f.runtime.credentials.save.bind(f.runtime.credentials)
      const commit = vi.spyOn(f.runtime.core, 'updateConnectionProvisioning')
      vi.spyOn(f.runtime.credentials, 'save').mockImplementationOnce(async (secret) => {
        entered()
        await gate
        return save(secret)
      })
      const change = f.runtime.updateConnectionConfiguration(
        f.connection.id,
        { endpoint: 'changed' },
        { token: 'fictional-new' },
      )
      const rejection = expect(change).rejects.toThrow('连接设置未保存')
      await started
      const disposal = f.runtime.dispose()
      release()
      await rejection
      await disposal
      expect(commit).not.toHaveBeenCalled()
      expect(await readdir(path.join(f.directory, 'credentials'))).toHaveLength(1)
    } finally {
      release()
      await f.close()
    }
  })

  it('preserves connection, channel and account identity while keeping, replacing and clearing a credential', async () => {
    const f = await fixture()
    try {
      const original = f.connection.credentialRefs['token']!
      await f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'changed' })
      expect(f.mounted.at(-1)).toEqual({ endpoint: 'changed', token: 'fictional-original' })
      await f.runtime.updateConnectionConfiguration(f.connection.id, {}, { token: 'fictional-replacement' })
      const changed = f.runtime.core.getConnection(f.connection.id)!
      expect(changed.credentialRefs['token']).not.toBe(original)
      expect(await f.runtime.credentials.has(original)).toBe(false)
      expect(f.mounted.at(-1)?.token).toBe('fictional-replacement')
      expect(f.runtime.core.connectionAccountPlatformUserId(f.connection.id)).toBe(f.identity)
      expect(f.runtime.core.listChannelsByConnection(f.connection.id)).toEqual([f.channel])
      expect(JSON.stringify(changed)).not.toContain('fictional-replacement')
      await f.runtime.updateConnectionConfiguration(f.connection.id, {}, { token: null })
      expect(f.runtime.core.getConnection(f.connection.id)?.credentialRefs).toEqual({})
      expect(f.mounted.at(-1)?.token).toBeUndefined()
      expect(await readdir(path.join(f.directory, 'credentials'))).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('rejects invalid fields, empty replacements and clearing a required credential before stopping the connection', async () => {
    const f = await fixture(true)
    try {
      for (const [configuration, credentials] of [
        [{}, { token: null }],
        [{ token: 'fictional' }, {}],
        [{}, { unknown: 'fictional' }],
        [{}, { token: '  ' }],
      ] as const)
        await expect(
          f.runtime.updateConnectionConfiguration(f.connection.id, configuration, credentials),
        ).rejects.toThrow()
      expect(f.mounted).toHaveLength(1)
      expect(f.runtime.core.getConnection(f.connection.id)?.credentialRefs).toEqual(f.connection.credentialRefs)
    } finally {
      await f.close()
    }
  })

  it('cleans staged credentials and preserves old settings if writing a second credential fails', async () => {
    const f = await fixture()
    try {
      const save = f.runtime.credentials.save.bind(f.runtime.credentials)
      vi.spyOn(f.runtime.credentials, 'save')
        .mockImplementationOnce(save)
        .mockRejectedValueOnce(new Error('synthetic disk failure'))
      await expect(
        f.runtime.updateConnectionConfiguration(
          f.connection.id,
          { endpoint: 'changed' },
          { token: 'fictional-new', auxiliary: 'fictional-aux' },
        ),
      ).rejects.toThrow('连接设置未保存')
      expect(f.runtime.core.getConnection(f.connection.id)?.config).toEqual(f.connection.config)
      expect(f.mounted).toHaveLength(1)
      expect(await readdir(path.join(f.directory, 'credentials'))).toHaveLength(1)
      expect(await f.runtime.credentials.resolve(f.connection.credentialRefs['token']!)).toBe('fictional-original')
    } finally {
      await f.close()
    }
  })

  it('restores the old runtime and removes staged files if the database commit fails', async () => {
    const f = await fixture()
    try {
      vi.spyOn(f.runtime.core, 'updateConnectionProvisioning').mockImplementationOnce(() => {
        throw new Error('synthetic database failure')
      })
      await expect(
        f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'changed' }, { token: 'fictional-new' }),
      ).rejects.toThrow('连接设置未保存')
      expect(f.mounted.at(-1)).toEqual({ endpoint: 'initial', token: 'fictional-original' })
      expect(await readdir(path.join(f.directory, 'credentials'))).toHaveLength(1)
      expect(f.runtime.core.getConnection(f.connection.id)?.config).toEqual(f.connection.config)
    } finally {
      await f.close()
    }
  })

  it('does not commit after a stop failure, and can edit a saved connection whose new settings fail to connect', async () => {
    const f = await fixture()
    try {
      f.faults.stop = true
      await expect(
        f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'changed' }, { token: 'fictional-new' }),
      ).rejects.toThrow('连接设置未保存')
      expect(f.runtime.core.getConnection(f.connection.id)?.config).toEqual(f.connection.config)
      f.faults.stop = false
      await f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'refused' })
      expect(f.runtime.adapterConnectionDiagnostic(f.connection.id)).toMatchObject({
        status: 'failed',
        message: '虚构平台拒绝连接。',
      })
      expect(f.runtime.core.getConnection(f.connection.id)?.config).toMatchObject({ endpoint: 'refused' })
      await f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'repaired' })
      expect(f.mounted.at(-1)?.endpoint).toBe('repaired')
      expect(f.runtime.adapterConnectionDiagnostic(f.connection.id)?.status).toBe('connected')
    } finally {
      await f.close()
    }
  })

  it('serializes simultaneous updates and deletion without losing retained fields or leaking credentials', async () => {
    const f = await fixture()
    try {
      await Promise.all([
        f.runtime.updateConnectionConfiguration(f.connection.id, { endpoint: 'changed' }, { token: 'fictional-new' }),
        f.runtime.updateConnectionConfiguration(f.connection.id, { enabled: false }),
      ])
      expect(f.runtime.core.getConnection(f.connection.id)?.config).toEqual({ endpoint: 'changed', enabled: false })
      expect(f.mounted.at(-1)?.token).toBe('fictional-new')
      await Promise.all([
        f.runtime.updateConnectionConfiguration(f.connection.id, {}, { token: 'fictional-final' }),
        f.runtime.deleteConnection(f.connection.id, { deleteChannelData: true }),
      ])
      expect(f.runtime.core.getConnection(f.connection.id)).toBeUndefined()
      expect(await readdir(path.join(f.directory, 'credentials'))).toEqual([])
    } finally {
      await f.close()
    }
  })
})
