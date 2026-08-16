import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('NekroNxt domain API — Connection diagnostics', () => {
  it('reports needs-credentials honestly for a QQ OpenClaw Connection without live credentials', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-conn-test-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    await runtime.start()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      // Create a QQ connection (credential stored as a reference only).
      const created = (await (
        await fetch(`${origin}/api/connections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: '102•481', credentialRef: 'credential:qq-main' }),
        })
      ).json()) as { connectionId: string; status: string }

      // Send-test on a QQ connection without live credentials must NOT fake success.
      const sendResponse = await fetch(`${origin}/api/connections/${created.connectionId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'send' }),
      })
      expect(sendResponse.ok).toBe(true)
      const sendResult = (await sendResponse.json()) as { status: string; message: string }
      expect(sendResult.status).toBe('needs-credentials')
      expect(sendResult.message).toContain('Client Secret')

      const receiveResponse = await fetch(`${origin}/api/connections/${created.connectionId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'receive' }),
      })
      expect(receiveResponse.ok).toBe(true)
      const receiveResult = (await receiveResponse.json()) as { status: string }
      expect(receiveResult.status).toBe('needs-credentials')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
