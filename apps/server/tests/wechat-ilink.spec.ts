import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createBuiltinAdapterContributions } from '@nekro-nxt/adapter-builtin-roster'
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

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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
  constructor(
    private readonly botToken = 'credential-secret-fixture',
    private readonly accountId = 'wx_account_fixture',
  ) {}

  async login(options?: WechatIlinkLoginOptions): Promise<WechatIlinkLoginResult> {
    await options?.onQRCode?.('https://qr.example.invalid/login-fixture')
    options?.onStatus?.('scaned')
    options?.onStatus?.('confirmed')
    return {
      connected: true,
      botToken: this.botToken,
      accountId: this.accountId,
      baseUrl: 'https://ilink-api.test',
      message: 'Login successful!',
    }
  }
}

const createTestAdapterContributions = (input: {
  readonly loginClientFactory: () => WechatIlinkLoginClient
  readonly transportFactory: (config: WechatIlinkTransportConfig) => WechatIlinkTransport
}) =>
  createBuiltinAdapterContributions({
    wechatIlinkLoginClientFactory: input.loginClientFactory,
    wechatIlinkTransportFactory: input.transportFactory,
  })

const readSnapshot = async (origin: string): Promise<ReturnType<typeof HostApiContracts.snapshot.parseResponse>> => {
  const response = await fetch(`${origin}/api/snapshot`)
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(body))
  return HostApiContracts.snapshot.parseResponse(body)
}

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
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
    let loginAttempt = 0
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      adapterContributions: createTestAdapterContributions({
        loginClientFactory: () => {
          loginAttempt += 1
          return new FakeWechatIlinkLoginClient(
            loginAttempt >= 3 ? 'credential-secret-reauthenticated' : 'credential-secret-fixture',
            loginAttempt >= 4 ? 'wx_account_other' : 'wx_account_fixture',
          )
        },
        transportFactory: (config) => {
          transport.config = config
          return transport
        },
      }),
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

      const loginResponse = await fetch(origin + '/api/connection-logins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adapterKey: 'wechat-ilink' }),
      })
      expect(loginResponse.status).toBe(201)
      const started = HostApiContracts.startConnectionLogin.parseResponse(await loginResponse.json())
      expect(started.qrCodeUrl).toBe('https://qr.example.invalid/login-fixture')

      let confirmed = HostApiContracts.getConnectionLogin.parseResponse(
        await (await fetch(origin + '/api/connection-logins/' + started.loginId)).json(),
      )
      await waitFor(async () => {
        confirmed = HostApiContracts.getConnectionLogin.parseResponse(
          await (await fetch(origin + '/api/connection-logins/' + started.loginId)).json(),
        )
        return confirmed.status === 'confirmed'
      })
      expect(confirmed).toMatchObject({ status: 'confirmed', adapterKey: 'wechat-ilink' })
      expect(confirmed.connectionId).toBeDefined()
      const connectionId = confirmed.connectionId!
      expect(() => runtime.cancelConnectionLogin(started.loginId)).toThrow('扫码登录会话已经结束')
      expect(runtime.getConnectionLogin(started.loginId)).toMatchObject({ status: 'confirmed', connectionId })

      const duplicateStarted = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink' })
      let duplicate = runtime.getConnectionLogin(duplicateStarted.loginId)
      await waitFor(() => {
        duplicate = runtime.getConnectionLogin(duplicateStarted.loginId)
        return duplicate.status === 'failed' || duplicate.status === 'confirmed'
      })
      expect(duplicate).toMatchObject({ status: 'failed', message: '该平台账号已经存在活动连接。' })
      expect(
        runtime.core.listConnections().filter((connection) => connection.adapterKey === 'wechat-ilink'),
      ).toHaveLength(1)

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

      let mediaResponse = await fetch(origin + '/api/connections/' + connectionId + '/configuration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configuration: { enableInboundMedia: false } }),
      })
      expect(mediaResponse.status).toBe(200)
      expect(HostApiContracts.updateConnectionConfiguration.parseResponse(await mediaResponse.json())).toEqual({
        connectionId,
        configuration: { enableInboundMedia: false },
      })
      expect(runtime.core.getConnection(connectionId)?.config).toMatchObject({ enableInboundMedia: false })
      snapshot = await readSnapshot(origin)
      expect(snapshot.connections.find((connection) => connection.id === connectionId)?.configuration).toEqual({
        enableInboundMedia: false,
      })

      mediaResponse = await fetch(origin + '/api/connections/' + connectionId + '/configuration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configuration: { enableInboundMedia: true } }),
      })
      expect(mediaResponse.status).toBe(200)
      expect(HostApiContracts.updateConnectionConfiguration.parseResponse(await mediaResponse.json())).toEqual({
        connectionId,
        configuration: { enableInboundMedia: true },
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

      const channelsBeforeReauthentication = runtime.core
        .listChannelsByConnection(connectionId)
        .map((channel) => channel.id)
      const reauthentication = await runtime.startConnectionLogin({
        adapterKey: 'wechat-ilink',
        connectionId,
      })
      let reauthenticated = runtime.getConnectionLogin(reauthentication.loginId)
      await waitFor(() => {
        reauthenticated = runtime.getConnectionLogin(reauthentication.loginId)
        return reauthenticated.status === 'confirmed' || reauthenticated.status === 'failed'
      })
      expect(reauthenticated).toMatchObject({ status: 'confirmed', connectionId, adapterKey: 'wechat-ilink' })
      expect(runtime.core.listConnectionsByAdapter('wechat-ilink').map((connection) => connection.id)).toEqual([
        connectionId,
      ])
      expect(runtime.core.listChannelsByConnection(connectionId).map((channel) => channel.id)).toEqual(
        channelsBeforeReauthentication,
      )
      const reauthenticatedCredentialFiles = await readdir(path.join(directory, 'credentials'))
      expect(reauthenticatedCredentialFiles).toHaveLength(1)
      expect(await readFile(path.join(directory, 'credentials', reauthenticatedCredentialFiles[0]!), 'utf8')).toBe(
        'credential-secret-reauthenticated',
      )

      const mismatchedReauthentication = await runtime.startConnectionLogin({
        adapterKey: 'wechat-ilink',
        connectionId,
      })
      let mismatched = runtime.getConnectionLogin(mismatchedReauthentication.loginId)
      await waitFor(() => {
        mismatched = runtime.getConnectionLogin(mismatchedReauthentication.loginId)
        return mismatched.status === 'confirmed' || mismatched.status === 'failed'
      })
      expect(mismatched).toMatchObject({
        status: 'failed',
        message: '扫码账号与原连接账号不一致，未替换凭据。',
      })
      expect(runtime.core.listConnectionsByAdapter('wechat-ilink').map((connection) => connection.id)).toEqual([
        connectionId,
      ])
      expect(runtime.core.listChannelsByConnection(connectionId).map((channel) => channel.id)).toEqual(
        channelsBeforeReauthentication,
      )
      const credentialsAfterMismatch = await readdir(path.join(directory, 'credentials'))
      expect(credentialsAfterMismatch).toHaveLength(1)
      expect(await readFile(path.join(directory, 'credentials', credentialsAfterMismatch[0]!), 'utf8')).toBe(
        'credential-secret-reauthenticated',
      )

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
      expect(JSON.stringify(snapshot)).not.toContain('credential-secret-reauthenticated')
      expect(JSON.stringify(snapshot)).not.toContain('ctx_redacted_fixture')
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })

  it('allows only one active reauthentication session per connection', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-wechat-ilink-reauth-race-'))
    temporaryDirectories.push(directory)
    const reauthenticationResult = deferred<WechatIlinkLoginResult>()
    let loginAttempt = 0
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      adapterContributions: createTestAdapterContributions({
        loginClientFactory: () => {
          loginAttempt += 1
          if (loginAttempt === 1) return new FakeWechatIlinkLoginClient()
          return {
            async login(options): Promise<WechatIlinkLoginResult> {
              await options?.onQRCode?.('https://qr.example.invalid/login-reauth-race')
              return reauthenticationResult.promise
            },
          }
        },
        transportFactory: () => new FakeWechatIlinkTransport(),
      }),
    })
    await runtime.start()

    try {
      const initialLogin = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink' })
      let initial = runtime.getConnectionLogin(initialLogin.loginId)
      await waitFor(() => {
        initial = runtime.getConnectionLogin(initialLogin.loginId)
        return initial.status === 'confirmed' || initial.status === 'failed'
      })
      expect(initial.status).toBe('confirmed')
      const connectionId = initial.connectionId!

      const reauthentication = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink', connectionId })
      await expect(runtime.startConnectionLogin({ adapterKey: 'wechat-ilink', connectionId })).rejects.toThrow(
        '该连接已有进行中的重新认证会话。',
      )

      expect(runtime.cancelConnectionLogin(reauthentication.loginId)).toMatchObject({ status: 'cancelled' })
      reauthenticationResult.resolve({
        connected: true,
        botToken: 'credential-secret-unused',
        accountId: 'wx_account_fixture',
        baseUrl: 'https://ilink-api.test',
        message: 'Login successful!',
      })
      await waitFor(() => runtime.getConnectionLogin(reauthentication.loginId).status === 'cancelled')
    } finally {
      reauthenticationResult.resolve({
        connected: true,
        botToken: 'credential-secret-unused',
        accountId: 'wx_account_fixture',
        baseUrl: 'https://ilink-api.test',
        message: 'Login successful!',
      })
      await runtime.dispose()
    }
  })

  it('keeps cancellation terminal while connection mounting is in flight and rolls back durable state', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-wechat-ilink-cancel-'))
    temporaryDirectories.push(directory)
    const loginResult = deferred<WechatIlinkLoginResult>()
    const mountStarted = deferred<void>()
    const releaseMount = deferred<void>()
    let loginOptions: WechatIlinkLoginOptions | undefined
    class BlockingWechatIlinkTransport extends FakeWechatIlinkTransport {
      override async start(input: WechatIlinkTransportStartInput): Promise<void> {
        this.startInput = input
        mountStarted.resolve()
        await releaseMount.promise
      }
    }
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      credentialRoot: path.join(directory, 'credentials'),
      adapterContributions: createTestAdapterContributions({
        loginClientFactory: () => ({
          async login(options): Promise<WechatIlinkLoginResult> {
            loginOptions = options
            await options?.onQRCode?.('https://qr.example.invalid/login-cancel-fixture')
            return loginResult.promise
          },
        }),
        transportFactory: () => new BlockingWechatIlinkTransport(),
      }),
    })
    await runtime.start()

    try {
      const started = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink' })
      loginOptions?.onStatus?.('confirmed')
      loginResult.resolve({
        connected: true,
        botToken: 'credential-secret-cancelled',
        accountId: 'wx_account_cancelled',
        baseUrl: 'https://ilink-api.test',
        message: 'Login successful!',
      })
      await mountStarted.promise

      expect(runtime.cancelConnectionLogin(started.loginId)).toMatchObject({ status: 'cancelled' })
      loginOptions?.onStatus?.('scaned')
      await loginOptions?.onQRCode?.('https://qr.example.invalid/login-late-fixture')
      const statusAfterLateCallbacks = runtime.getConnectionLogin(started.loginId).status
      releaseMount.resolve()
      await waitFor(async () => {
        if (runtime.core.listConnectionsByAdapter('wechat-ilink').length !== 0) return false
        return (await readdir(path.join(directory, 'credentials'))).length === 0
      })

      expect(statusAfterLateCallbacks).toBe('cancelled')
      expect(runtime.getConnectionLogin(started.loginId)).toMatchObject({ status: 'cancelled' })
      expect(await readdir(path.join(directory, 'credentials'))).toEqual([])
    } finally {
      releaseMount.resolve()
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
      adapterContributions: createTestAdapterContributions({
        loginClientFactory: () => new FakeWechatIlinkLoginClient(),
        transportFactory: () => new FakeWechatIlinkTransport(),
      }),
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

it('reauthentication preserves the user media setting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-review-setting-'))
  temporaryDirectories.push(directory)
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    credentialRoot: path.join(directory, 'credentials'),
    adapterContributions: createTestAdapterContributions({
      loginClientFactory: () => new FakeWechatIlinkLoginClient(),
      transportFactory: () => new FakeWechatIlinkTransport(),
    }),
  })
  await runtime.start()
  try {
    const initial = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink' })
    await waitFor(() => runtime.getConnectionLogin(initial.loginId).status === 'confirmed')
    const connectionId = runtime.getConnectionLogin(initial.loginId).connectionId!
    await runtime.updateConnectionConfiguration(connectionId, { enableInboundMedia: false })
    expect(runtime.core.getConnection(connectionId)?.config).toMatchObject({ enableInboundMedia: false })
    const login = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink', connectionId })
    await waitFor(() => runtime.getConnectionLogin(login.loginId).status === 'confirmed')
    expect(runtime.core.getConnection(connectionId)?.config).toMatchObject({ enableInboundMedia: false })
  } finally {
    await runtime.dispose()
  }
})

it('cancelled reauthentication stops the replacement transport before rollback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-review-rollback-'))
  temporaryDirectories.push(directory)
  const mounting = deferred<void>()
  const releaseMount = deferred<void>()
  const transports: Array<{ stopCount: number; signal?: AbortSignal }> = []
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(directory, 'core.sqlite'),
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    assetRoot: path.join(directory, 'assets'),
    extensionDataRoot: path.join(directory, 'extension-data'),
    extensionCacheRoot: path.join(directory, 'extension-cache'),
    credentialRoot: path.join(directory, 'credentials'),
    adapterContributions: createTestAdapterContributions({
      loginClientFactory: () => new FakeWechatIlinkLoginClient(),
      transportFactory: () => {
        const index = transports.length
        const record: { stopCount: number; signal?: AbortSignal } = { stopCount: 0 }
        transports.push(record)
        return {
          async start(input) {
            record.signal = input.signal
            if (index === 1) {
              mounting.resolve()
              await releaseMount.promise
            }
          },
          stop() {
            record.stopCount++
            return Promise.resolve()
          },
          sendText() {
            return Promise.resolve({ clientId: 'fixture-send' })
          },
        }
      },
    }),
  })
  await runtime.start()
  try {
    const initial = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink' })
    await waitFor(() => runtime.getConnectionLogin(initial.loginId).status === 'confirmed')
    const connectionId = runtime.getConnectionLogin(initial.loginId).connectionId!
    const login = await runtime.startConnectionLogin({ adapterKey: 'wechat-ilink', connectionId })
    await mounting.promise
    runtime.cancelConnectionLogin(login.loginId)
    releaseMount.resolve()
    await waitFor(() => transports.length === 3)
    expect(transports[1]!.stopCount).toBe(1)
    expect(transports[1]!.signal?.aborted).toBe(true)
  } finally {
    releaseMount.resolve()
    await runtime.dispose()
  }
})
