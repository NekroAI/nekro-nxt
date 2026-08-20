import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { QQGatewaySocket } from '@nekro-nxt/adapter-qq-openclaw'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

const readSnapshot = async (origin: string): Promise<ReturnType<typeof HostApiContracts.snapshot.parseResponse>> => {
  const response = await fetch(`${origin}/api/snapshot`)
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(body))
  return HostApiContracts.snapshot.parseResponse(body)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const gatewaySocket = (signal: AbortSignal): QQGatewaySocket => ({
  messages: {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })
      yield JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'real-assembly-session' } })
      yield JSON.stringify({
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        s: 2,
        d: {
          id: 'qq-real-inbound-1',
          group_openid: 'group-real-1',
          group_name: '真实装配测试群',
          author: { member_openid: 'member-real-1', username: '测试成员' },
          content: '你好',
          timestamp: 1,
        },
      })
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void =>
          reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway socket aborted.'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  },
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
})

describe('NekroNxt domain API — real QQ Connection diagnostics', () => {
  it('stores the submitted Secret privately, receives through Gateway and sends through QQ HTTP', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-conn-test-'))
    temporaryDirectories.push(directory)
    const requests: Array<{ readonly url: string; readonly body?: string }> = []
    const qqFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
      if (url.endsWith('/app/getAppAccessToken')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'qq-access-token', expires_in: 7200 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      if (url.endsWith('/gateway')) {
        return Promise.resolve(
          new Response(JSON.stringify({ url: 'wss://gateway.qq.test' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      if (url.includes('/v2/groups/group-real-1/messages')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'qq-real-outbound-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(new Response(JSON.stringify({ message: 'unexpected request' }), { status: 500 }))
    }
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      qq: {
        fetch: qqFetch,
        sockets: { connect: (_url, signal) => Promise.resolve(gatewaySocket(signal)) },
        clock: {
          now: () => 1_000,
          sleep: (_delay, signal) =>
            new Promise<void>((_resolve, reject) => {
              const abort = (): void =>
                reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway sleep aborted.'))
              if (signal.aborted) abort()
              else signal.addEventListener('abort', abort, { once: true })
            }),
          setInterval: () => () => {},
        },
      },
    })
    await runtime.start()
    await runtime.recover()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      const createdResponse = await fetch(`${origin}/api/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          adapterKey: 'qq-openclaw',
          alias: '测试机器人',
          configuration: { appId: 'app-real-1', proactiveSend: true },
          credentials: { clientSecretCredentialRef: 'client-secret-real-1' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const created = HostApiContracts.createConnection.parseResponse(await createdResponse.json())

      const before = Date.now()
      let snapshot = await readSnapshot(origin)
      for (;;) {
        snapshot = await readSnapshot(origin)
        const connection = snapshot.connections.find((candidate) => candidate.id === created.connectionId)
        if (connection?.gateway?.state === 'connected' && connection.channelCount === 1) break
        if (Date.now() - before > 5_000) {
          throw new Error(`Timed out waiting for the QQ Gateway assembly: ${JSON.stringify(connection)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const projected = snapshot.connections.find((connection) => connection.id === created.connectionId)!
      expect(projected).toMatchObject({
        adapterKey: 'qq-openclaw',
        alias: '测试机器人',
        credentialConfigured: true,
        channelCount: 1,
        gateway: { state: 'connected' },
      })
      expect(JSON.stringify(snapshot)).not.toContain('client-secret-real-1')
      expect(JSON.stringify(runtime.core.listConnections())).not.toContain('client-secret-real-1')

      const credentialFiles = await readdir(path.join(directory, 'credentials'))
      expect(credentialFiles).toHaveLength(1)
      expect(await readFile(path.join(directory, 'credentials', credentialFiles[0]!), 'utf8')).toBe(
        'client-secret-real-1',
      )

      const receiveResult = HostApiContracts.testConnection.parseResponse(
        await (
          await fetch(`${origin}/api/connections/${created.connectionId}/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'receive' }),
          })
        ).json(),
      )
      expect(receiveResult).toMatchObject({ status: 'received', platformMessageId: 'qq-real-inbound-1' })

      const sendResult = HostApiContracts.testConnection.parseResponse(
        await (
          await fetch(`${origin}/api/connections/${created.connectionId}/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'send' }),
          })
        ).json(),
      )
      expect(sendResult).toMatchObject({ status: 'sent', platformMessageId: 'qq-real-outbound-1' })
      expect(requests.find(({ url }) => url.includes('/v2/groups/group-real-1/messages'))?.body).toContain(
        'NekroNxt QQ 连接发送测试',
      )
      expect(requests.find(({ url }) => url.endsWith('/app/getAppAccessToken'))?.body).toContain('client-secret-real-1')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  }, 15_000)

  it('reuses the durable Web Connection and restores the QQ Runtime from its credential reference', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-conn-restart-'))
    temporaryDirectories.push(directory)
    const qqFetch: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      return Promise.resolve(
        url.endsWith('/app/getAppAccessToken')
          ? new Response(JSON.stringify({ access_token: 'restart-token', expires_in: 7200 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ url: 'wss://gateway.qq.test' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      )
    }
    let resumed = false
    const options = {
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      qq: {
        fetch: qqFetch,
        sockets: {
          connect: (_url: string, signal: AbortSignal) =>
            Promise.resolve<QQGatewaySocket>({
              messages: {
                async *[Symbol.asyncIterator]() {
                  yield JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })
                  yield JSON.stringify(
                    resumed
                      ? { op: 0, t: 'RESUMED', s: 3, d: {} }
                      : { op: 0, t: 'READY', s: 1, d: { session_id: 'restart-session' } },
                  )
                  await new Promise<void>((_resolve, reject) => {
                    const abort = (): void =>
                      reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway socket aborted.'))
                    if (signal.aborted) abort()
                    else signal.addEventListener('abort', abort, { once: true })
                  })
                },
              },
              send: () => Promise.resolve(),
              close: () => Promise.resolve(),
            }),
        },
        clock: {
          now: () => 1_000,
          sleep: (_delay: number, signal: AbortSignal) =>
            new Promise<void>((_resolve, reject) => {
              const abort = (): void =>
                reject(signal.reason instanceof Error ? signal.reason : new Error('Gateway sleep aborted.'))
              if (signal.aborted) abort()
              else signal.addEventListener('abort', abort, { once: true })
            }),
          setInterval: () => () => {},
        },
      },
    } as const

    const first = await NekroRuntime.create(options)
    await first.start()
    await first.recover()
    const webConnectionId = first.webConnectionId
    const qqConnection = await first.createQQConnection({
      appId: 'restart-app',
      clientSecret: 'restart-secret',
    })
    const damagedConnection = first.core.createConnection({
      adapterKey: 'qq-openclaw',
      config: { appId: 'damaged-app' },
      credentialRefs: { clientSecret: 'damaged-reference' },
    })
    const credentialReference = qqConnection.credentialRefs['clientSecret']!
    const before = Date.now()
    while (first.connectionDiagnostic(qqConnection.id)?.gateway.state !== 'connected') {
      if (Date.now() - before > 5_000) throw new Error('Timed out waiting for initial QQ connection.')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await first.dispose()

    resumed = true
    const second = await NekroRuntime.create(options)
    await second.start()
    await second.recover()
    try {
      const restoreBefore = Date.now()
      while (second.connectionDiagnostic(qqConnection.id)?.gateway.state !== 'connected') {
        if (Date.now() - restoreBefore > 5_000) throw new Error('Timed out waiting for restored QQ connection.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(second.webConnectionId).toBe(webConnectionId)
      expect(second.core.listConnectionsByAdapter('web')).toHaveLength(1)
      expect(second.core.listConnectionsByAdapter('qq-openclaw')).toHaveLength(2)
      expect(second.connectionDiagnostic(qqConnection.id)).toMatchObject({
        gateway: { state: 'connected', resumed: true },
        credentialConfigured: true,
      })
      expect(second.connectionDiagnostic(damagedConnection.id)).toMatchObject({
        gateway: { state: 'failed' },
        credentialConfigured: false,
      })
    } finally {
      await second.dispose()
    }

    await second.credentials.delete(credentialReference)
    const third = await NekroRuntime.create(options)
    await third.start()
    await third.recover()
    try {
      expect(third.connectionDiagnostic(qqConnection.id)).toMatchObject({
        gateway: { state: 'failed' },
        credentialConfigured: false,
      })
      expect(third.connectionDiagnostic(third.core.listConnectionsByAdapter('qq-openclaw')[0]!.id)?.gateway.state).toBe(
        'failed',
      )
    } finally {
      await third.dispose()
    }
  })
})
