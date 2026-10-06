import type { AdapterConnectionHostContext, AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'

const runtimeOptions = (directory: string) => ({
  coreDatabasePath: path.join(directory, 'core.sqlite'),
  sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
  assetRoot: path.join(directory, 'assets'),
  extensionDataRoot: path.join(directory, 'extensions'),
  extensionCacheRoot: path.join(directory, 'cache'),
})

describe('generic Adapter Connection assembly', () => {
  it('mounts a fictional Adapter and keeps Connection facts outside Channels', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-fixture-connection-'))
    const runtime = await NekroRuntime.create(runtimeOptions(directory))
    let context: AdapterConnectionHostContext | undefined
    const contribution: AdapterHostContributionV2 = {
      apiVersion: 2,
      descriptor: {
        key: 'fixture-alpha',
        displayName: 'Fixture Alpha',
        description: 'Synthetic Adapter used by the Server boundary test.',
        provisioning: 'user-created',
        aliasEditable: true,
        channelDiscovery: 'adapter-observed',
        channelKinds: ['group'],
        activities: [
          {
            key: 'fixture.account-updated',
            scope: 'connection',
            displayName: 'Account updated',
            description: 'Synthetic account activity.',
            triggerable: false,
          },
        ],
        features: {},
        diagnostics: { receive: true, send: true },
        configSchema: { type: 'object', dict: {} },
      },
      create: (host) => {
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
            activities: { 'fixture.account-updated': { state: 'available' } },
          },
          start: () => {
            host.diagnostics.publish({ status: 'connected', proactiveSend: true })
            return Promise.resolve()
          },
          stop: () => Promise.resolve(),
          deliver: () => Promise.resolve({ status: 'sent' as const, platformMessageId: 'fixture-message' }),
        })
      },
    }

    try {
      await runtime.start()
      await runtime.registerAdapter('test:fixture-alpha', contribution)
      const connection = await runtime.createConnection({ adapterKey: contribution.descriptor.key })
      const channel = runtime.core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'fixture-room',
        kind: 'group',
        displayName: 'Fixture room',
      })
      await expect(runtime.testConnection(connection.id, 'send', channel.id)).resolves.toMatchObject({
        status: 'sent',
        channelId: channel.id,
      })

      const identityId = await context!.identities.ensure({ platformUserId: 'fixture-user', observedAt: 10 })
      await context!.acceptConnectionInbound({
        connectionId: connection.id,
        adapterKey: contribution.descriptor.key,
        activityKey: 'fixture.account-updated',
        summary: 'Fixture account data changed.',
        actorIdentityId: identityId,
        sourceTimestamp: 10,
        receivedAt: 11,
        dedupeKey: 'fixture-account-updated-1',
      })
      expect(runtime.core.listConnectionEvents(connection.id)).toHaveLength(1)
      expect(runtime.core.listChannelsByConnection(connection.id)).toEqual([channel])
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
