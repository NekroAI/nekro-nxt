import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('OneBot 11 Server driver', () => {
  it('creates through the Adapter directory and stores Access Token only as a credential reference', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-onebot-driver-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
    })
    await runtime.start()
    try {
      expect(runtime.listConnectionAdapters()).toContainEqual(
        expect.objectContaining({ key: 'onebot-11', displayName: 'OneBot 11', userCreatable: true }),
      )
      const connection = await runtime.createConnection({
        adapterKey: 'onebot-11',
        alias: '测试协议端',
        configuration: {
          endpoint: 'ws://127.0.0.1:9/universal',
          capturePokeEvents: true,
          captureMessageReactionEvents: false,
        },
        credentials: { accessToken: 'fixture-access-token' },
      })
      expect(connection).toMatchObject({ adapterKey: 'onebot-11', alias: '测试协议端' })
      expect(connection.config).toEqual({
        endpoint: 'ws://127.0.0.1:9/universal',
        capturePokeEvents: true,
        captureMessageReactionEvents: false,
      })
      expect(connection.credentialRefs['accessToken']).toMatch(/^credential:local:/u)
      expect(JSON.stringify(connection)).not.toContain('fixture-access-token')
    } finally {
      await runtime.dispose()
    }
  })
})
