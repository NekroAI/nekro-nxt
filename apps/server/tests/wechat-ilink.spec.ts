import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  type WechatIlinkLoginClient,
  type WechatIlinkLoginOptions,
  type WechatIlinkLoginResult,
  type WechatIlinkMessage,
  type WechatIlinkTransport,
  type WechatIlinkTransportConfig,
  type WechatIlinkTransportStartInput,
} from '@nekro-nxt/adapter-wechat-ilink'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

class FakeWechatIlinkTransport implements WechatIlinkTransport {
  readonly sent: Array<{ readonly toUserId: string; readonly text: string; readonly contextToken: string }> = []
  config: WechatIlinkTransportConfig | undefined
  startInput: WechatIlinkTransportStartInput | undefined

  start(input: WechatIlinkTransportStartInput): Promise<void> {
    this.startInput = input
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  sendText(input: {
    readonly toUserId: string
    readonly text: string
    readonly contextToken: string
    readonly signal: AbortSignal
  }) {
    this.sent.push({ toUserId: input.toUserId, text: input.text, contextToken: input.contextToken })
    return Promise.resolve({ clientId: 'wechat-client-fixture' })
  }

  emitMessage(message: WechatIlinkMessage): void {
    void this.startInput?.onMessage(message)
  }
}

class FakeWechatIlinkLoginClient implements WechatIlinkLoginClient {
  async login(options?: WechatIlinkLoginOptions): Promise<WechatIlinkLoginResult> {
    await options?.onQRCode?.('https://qr.example.invalid/login-fixture')
    options?.onStatus?.('scaned')
    options?.onStatus?.('confirmed')
    return {
      connected: true,
      botToken: 'credential-secret-fixture',
      accountId: 'wx_account_fixture',
      baseUrl: 'https://ilink-api.test',
      message: 'Login successful!',
    }
  }
}

const readSnapshot = async (origin: string): Promise<ReturnType<typeof HostApiContracts.snapshot.parseResponse>> => {
  const response = await fetch(`${origin}/api/snapshot`)
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(body))
  return HostApiContracts.snapshot.parseResponse(body)
}

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WeChat iLink Server driver', () => {
  it('creates through the Adapter directory and closes the private text loop with a fake transport', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-wechat-ilink-driver-'))
    temporaryDirectories.push(directory)
    const transport = new FakeWechatIlinkTransport()
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      wechatIlink: {
        loginClientFactory: () => new FakeWechatIlinkLoginClient(),
        transportFactory: (config) => {
          transport.config = config
          return transport
        },
      },
    })
    await runtime.start()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      let snapshot = await readSnapshot(origin)
      const descriptor = snapshot.connectionAdapters.find((adapter) => adapter.key === 'wechat-ilink')
      expect(descriptor).toMatchObject({
        key: 'wechat-ilink',
        displayName: '微信 iLink',
        provisioning: 'user-created',
        creation: { mode: 'qr-login', actionLabel: '扫码登录' },
        configSchema: {
          required: [],
          properties: {
            enableInboundMedia: {
              type: 'boolean',
              title: '入站媒体接收',
              default: true,
            },
          },
        },
      })
      const publicDescriptor = JSON.stringify(descriptor)
      expect(publicDescriptor).not.toContain('机器人账号 ID')
      expect(publicDescriptor).not.toContain('访问令牌')
      expect(publicDescriptor).not.toContain('API 地址')
      expect(publicDescriptor).not.toContain('CDN 地址')

      const loginResponse = await fetch(origin + '/api/connections/wechat-ilink/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(loginResponse.status).toBe(201)
      const started = HostApiContracts.startWechatIlinkLogin.parseResponse(await loginResponse.json())
      expect(started.qrCodeUrl).toBe('https://qr.example.invalid/login-fixture')

      let confirmed = HostApiContracts.getWechatIlinkLogin.parseResponse(
        await (await fetch(origin + '/api/connections/wechat-ilink/login/' + started.loginId)).json(),
      )
      await waitFor(async () => {
        confirmed = HostApiContracts.getWechatIlinkLogin.parseResponse(
          await (await fetch(origin + '/api/connections/wechat-ilink/login/' + started.loginId)).json(),
        )
        return confirmed.status === 'confirmed'
      })
      expect(confirmed).toMatchObject({ status: 'confirmed', adapterKey: 'wechat-ilink' })
      expect(confirmed.connectionId).toBeDefined()
      const connectionId = confirmed.connectionId!

      expect(transport.config).toEqual({
        accountId: 'wx_account_fixture',
        token: 'credential-secret-fixture',
        baseUrl: 'https://ilink-api.test',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      })
      const storedConnection = runtime.core.getConnection(connectionId)
      expect(storedConnection).toMatchObject({ adapterKey: 'wechat-ilink' })
      expect(storedConnection?.config).toMatchObject({ enableInboundMedia: true, enableOutboundMedia: false })
      expect(storedConnection?.credentialRefs['botToken']).toMatch(/^credential:local:/u)
      expect(JSON.stringify(storedConnection)).not.toContain('credential-secret-fixture')

      let mediaResponse = await fetch(origin + '/api/connections/' + connectionId + '/wechat-ilink/inbound-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enableInboundMedia: false }),
      })
      expect(mediaResponse.status).toBe(200)
      expect(HostApiContracts.updateWechatIlinkInboundMedia.parseResponse(await mediaResponse.json())).toEqual({
        connectionId,
        enableInboundMedia: false,
      })
      expect(runtime.core.getConnection(connectionId)?.config).toMatchObject({ enableInboundMedia: false })
      snapshot = await readSnapshot(origin)
      expect(snapshot.connections.find((connection) => connection.id === connectionId)?.adapterSettings).toEqual({
        wechatIlink: { enableInboundMedia: false },
      })

      mediaResponse = await fetch(origin + '/api/connections/' + connectionId + '/wechat-ilink/inbound-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enableInboundMedia: true }),
      })
      expect(mediaResponse.status).toBe(200)
      expect(HostApiContracts.updateWechatIlinkInboundMedia.parseResponse(await mediaResponse.json())).toEqual({
        connectionId,
        enableInboundMedia: true,
      })
      expect(runtime.core.getConnection(connectionId)?.config).toMatchObject({ enableInboundMedia: true })

      const credentialFiles = await readdir(path.join(directory, 'credentials'))
      expect(credentialFiles).toHaveLength(1)
      expect(await readFile(path.join(directory, 'credentials', credentialFiles[0]!), 'utf8')).toBe(
        'credential-secret-fixture',
      )

      await transport.startInput?.saveSyncBuf('sync-buf-fixture')
      transport.emitMessage({
        message_id: 'wechat-message-fixture',
        from_user_id: 'wx_user_alpha',
        create_time_ms: 12_000,
        context_token: 'ctx_redacted_fixture',
        item_list: [{ item_type: 1, text_item: { text: '你好，NekroNXT' } }],
      })

      await waitFor(async () => {
        snapshot = await readSnapshot(origin)
        return snapshot.connections.some(
          (connection) => connection.id === connectionId && connection.channelCount === 1,
        )
      })

      const receiveResult = HostApiContracts.testConnection.parseResponse(
        await (
          await fetch(origin + '/api/connections/' + connectionId + '/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'receive' }),
          })
        ).json(),
      )
      expect(receiveResult).toMatchObject({ status: 'received', platformMessageId: 'wechat-message-fixture' })

      const sendResult = HostApiContracts.testConnection.parseResponse(
        await (
          await fetch(origin + '/api/connections/' + connectionId + '/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ direction: 'send' }),
          })
        ).json(),
      )
      expect(sendResult).toMatchObject({ status: 'sent', platformMessageId: 'wechat-client-fixture' })
      expect(transport.sent).toEqual([
        {
          toUserId: 'wx_user_alpha',
          text: 'NekroNXT 连接诊断测试消息。',
          contextToken: 'ctx_redacted_fixture',
        },
      ])

      snapshot = await readSnapshot(origin)
      const projected = snapshot.connections.find((connection) => connection.id === connectionId)
      expect(projected).toMatchObject({
        adapterKey: 'wechat-ilink',
        status: { state: 'connected', credentialConfigured: true, proactiveSend: false },
        channelCount: 1,
        receiveTest: { status: 'received', platformMessageId: 'wechat-message-fixture' },
        sendTest: { status: 'sent', platformMessageId: 'wechat-client-fixture' },
      })
      expect(JSON.stringify(snapshot)).not.toContain('credential-secret-fixture')
      expect(JSON.stringify(snapshot)).not.toContain('ctx_redacted_fixture')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('rejects generic connection creation for qr-login WeChat iLink', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-wechat-ilink-create-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      wechatIlink: {
        loginClientFactory: () => new FakeWechatIlinkLoginClient(),
        transportFactory: () => new FakeWechatIlinkTransport(),
      },
    })
    await runtime.start()

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      await expect(runtime.createConnection({ adapterKey: 'wechat-ilink', configuration: {} })).rejects.toThrow(
        '该连接需要通过扫码登录创建，不能使用通用配置表单。',
      )

      const response = await fetch(origin + '/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adapterKey: 'wechat-ilink', configuration: {} }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'connection-failed',
          message: '该连接需要通过扫码登录创建，不能使用通用配置表单。',
        },
      })
      expect(runtime.core.listConnections().filter((connection) => connection.adapterKey === 'wechat-ilink')).toEqual(
        [],
      )
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
