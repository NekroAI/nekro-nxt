import { expect, test, type Page } from '@playwright/test'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

type HostSnapshot = ReturnType<typeof HostApiContracts.snapshot.response.parse>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface JourneyServer {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  diagnostics(): string
}

const reserveJourneyPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法为 Host 恢复旅程分配端口。')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })

const spawnJourneyServer = (port: number, dataRoot: string): JourneyServer => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'apps/server/dist/main.mjs')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NEKRO_DATA: dataRoot,
      NEKRO_DIST_INDEX: path.join(repositoryRoot, 'apps/web/dist/index.html'),
      NEKRO_HOST: '127.0.0.1',
      NEKRO_LLM_PROVIDERS: '',
      NEKRO_PORT: String(port),
      NEKRO_RELEASE_ID: 'journey-host-restart',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  return { child, exited, diagnostics: () => output }
}

const waitForJourneyServerReady = async (origin: string, server: JourneyServer): Promise<void> => {
  const deadline = Date.now() + 60_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Host 在就绪前退出。\n${server.diagnostics()}`)
    }
    try {
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1_000) })
      const body: unknown = response.ok ? await response.json() : undefined
      if (isRecord(body) && body['status'] === 'ready' && body['releaseId'] === 'journey-host-restart') return
      lastError = new Error(`Host readiness 返回 ${response.status}。`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Host 未能在产品旅程时限内就绪。\n${server.diagnostics()}`, { cause: lastError })
}

const stopJourneyServer = async (server: JourneyServer): Promise<void> => {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    await server.exited
    return
  }
  server.child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      server.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Host 未能及时退出。\n${server.diagnostics()}`)), 20_000)
      }),
    ])
  } catch (error) {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL')
    await server.exited.catch(() => undefined)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const installDeepSeekProviderRoutes = async (
  page: Page,
  initiallySaved = false,
): Promise<{ readonly saveRequests: unknown[] }> => {
  let saved = initiallySaved
  const saveRequests: unknown[] = []
  const responseBody = (): Record<string, unknown> => ({
    writable: true,
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    providers: [
      {
        provider: 'deepseek',
        displayName: 'deepseek',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'],
        settingsRevision: saved ? 2 : 1,
        declared: false,
        active: saved,
        configured: true,
        credential: { configured: saved, writable: true },
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      },
    ],
  })

  await page.route('**/api/llm/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseBody()) })
  })
  await page.route('**/api/llm/providers/deepseek', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const payload: unknown = route.request().postDataJSON()
    saveRequests.push(payload)
    if (!isRecord(payload) || typeof payload['expectedRevision'] !== 'number') {
      throw new TypeError('模型供应商保存请求缺少 expectedRevision。')
    }
    saved = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseBody()) })
  })
  return { saveRequests }
}

const installRuntimeFailureGate = (page: Page): string[] => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

test('production bundle keeps every primary route usable without runtime errors', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  const routes = [
    ['/', '工作'],
    ['/work', '工作'],
    ['/work/agents/new', '工作'],
    ['/connections', '连接'],
    ['/users', '用户'],
    ['/extensions', '扩展'],
    ['/work/creator', '工作'],
    ['/runtime', '工作'],
    ['/settings', '设置'],
  ] as const

  for (const [route, visibleText] of routes) {
    await page.goto(route)
    await expect(page.getByRole('link', { name: visibleText }).first()).toBeVisible()
    await expect(page.locator('#root')).not.toBeEmpty()
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('the open page reconnects after the real Host restarts on the same origin', async ({ page }) => {
  test.setTimeout(120_000)
  const port = await reserveJourneyPort()
  const origin = `http://127.0.0.1:${port}`
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-host-restart-'))
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let firstServer: JourneyServer | undefined
  let recoveredServer: JourneyServer | undefined

  try {
    firstServer = spawnJourneyServer(port, dataRoot)
    await waitForJourneyServerReady(origin, firstServer)
    await page.goto(`${origin}/settings`)
    await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '连接不稳定' })).toHaveCount(0)

    const marker = 'same-document-host-recovery'
    await page.evaluate((value) => {
      document.documentElement.dataset['hostRestartJourney'] = value
    }, marker)
    const urlBeforeRestart = page.url()

    await stopJourneyServer(firstServer)
    firstServer = undefined
    await expect(page.getByRole('alert').filter({ hasText: '连接不稳定' })).toBeVisible({ timeout: 15_000 })

    recoveredServer = spawnJourneyServer(port, dataRoot)
    await waitForJourneyServerReady(origin, recoveredServer)
    await expect(page.getByRole('alert').filter({ hasText: '连接不稳定' })).toHaveCount(0, { timeout: 20_000 })

    expect(page.url()).toBe(urlBeforeRestart)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset['hostRestartJourney'])).toBe(marker)
    await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toBeVisible()
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    if (recoveredServer !== undefined) await stopJourneyServer(recoveredServer)
    if (firstServer !== undefined) await stopJourneyServer(firstServer)
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('the open page recovers when an intermediary returns HTTP 500 for the SSE handshake', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let hostAvailable = false
  let eventAttempts = 0

  await page.route('**/api/snapshot', (route) => {
    if (hostAvailable) return route.continue()
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Host 正在重新启动。' } }),
    })
  })
  await page.route('**/api/events', (route) => {
    eventAttempts += 1
    if (hostAvailable) return route.continue()
    return route.fulfill({ status: 500, contentType: 'text/plain', body: '' })
  })

  await page.goto('/connections')
  await expect(page.getByRole('alert').filter({ hasText: '无法连接' })).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset['sseRecoveryJourney'] = 'same-document'
  })

  hostAvailable = true
  await expect(page.getByRole('alert').filter({ hasText: '无法连接' })).toHaveCount(0, { timeout: 10_000 })
  expect(eventAttempts).toBeGreaterThanOrEqual(2)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['sseRecoveryJourney']))
    .toBe('same-document')
  await expect(page.getByRole('heading', { name: '内置频道', level: 1 })).toBeVisible()
  expect(pageErrors, pageErrors.join('\n')).toEqual([])
})

test('legacy work links replace into /work without dropping query or hash', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)

  await page.goto('/agents?create=1#draft')
  await expect(page).toHaveURL(/\/work\/agents\/new#draft$/u)
  await expect(page.getByRole('heading', { name: '创建智能体' })).toBeVisible()

  await page.goto('/creator?agent=agt_compat#preview')
  await expect(page).toHaveURL(/\/work\/creator\?agent=agt_compat#preview$/u)

  await page.goto('/channels')
  await expect(page).toHaveURL(/\/work(?:\/|$)/u)

  expect(failures, failures.join('\n')).toEqual([])
})

test('settings exposes the provider editor and survives real navigation', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installDeepSeekProviderRoutes(page, true)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /DeepSeek/u }).click()
  await expect(page.getByLabel('API 密钥')).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('API 密钥')).toHaveAttribute('autocomplete', 'off')
  await expect(page.getByLabel('API 密钥')).toHaveAttribute('data-1p-ignore', 'true')
  await expect(page.getByText(/已保存密钥无法查看/u)).toBeVisible()

  await page.getByRole('link', { name: /系统扩展/u }).click()
  await expect(page.getByRole('heading', { name: '系统扩展', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toHaveCount(0)
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  await expect(page.locator('[data-stage-layer="in"]')).toHaveCSS('opacity', '1')
  await expect(page.getByText('接入聊天平台。前往「连接」添加账号。', { exact: true })).toBeVisible()
  await expect(page.getByText('由 NekroNXT 直接提供，用于应用内对话。', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '工作' }).click()
  await expect(page.getByRole('link', { name: '工作' })).toBeVisible()
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toBeVisible()

  expect(failures, failures.join('\n')).toEqual([])
})

test('notification settings present system delivery before Bark and keep feature switches usable', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings?tab=notifications')

  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible()
  const systemHeading = page.getByText('系统通知渠道', { exact: true })
  const barkHeading = page.getByText('Bark 通知渠道', { exact: true })
  const eventsHeading = page.getByText('通知项目', { exact: true })
  await expect(systemHeading).toBeVisible()
  await expect(barkHeading).toBeVisible()
  await expect(eventsHeading).toBeVisible()
  const headingPositions = await Promise.all(
    [systemHeading, barkHeading, eventsHeading].map((item) =>
      item.evaluate((node) => node.getBoundingClientRect().top),
    ),
  )
  expect(headingPositions[0]).toBeLessThan(headingPositions[1]!)
  expect(headingPositions[1]).toBeLessThan(headingPositions[2]!)

  await expect(page.getByRole('switch', { name: '启用系统通知' })).toBeChecked()
  await expect(page.getByRole('switch', { name: '启用 Bark 通知' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '扩展预览等待确认' })).toBeChecked()

  await page.getByRole('button', { name: '发送系统测试通知' }).click()
  await expect(page.getByText(/系统测试通知已发布/u)).toBeVisible()
  await page.getByRole('button', { name: '保存通知设置' }).click()
  await expect(page.getByText('通知设置已保存。', { exact: true })).toBeVisible()

  expect(failures, failures.join('\n')).toEqual([])
})

test('provider connection test uses the unsaved page draft without saving it', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  const { saveRequests } = await installDeepSeekProviderRoutes(page, true)
  const testRequests: unknown[] = []
  await page.route('**/api/llm/test-provider', async (route) => {
    const payload = HostApiContracts.llmTestProvider.request.parse(route.request().postDataJSON())
    testRequests.push(payload)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: payload.provider, model: payload.model }),
    })
  })
  await page.goto('/settings')
  await page.getByRole('button', { name: '添加供应商' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: '开始配置' }).click()
  await page.getByLabel('供应商名称').fill('Draft Gateway')
  await page.getByLabel('API 密钥').fill('unsaved-draft-key')
  await page.getByLabel('API 地址').fill('https://draft.example.test/v1')
  await page.getByLabel('API 协议').click()
  await page.getByRole('option', { name: 'openai-completions' }).click()
  await page.getByLabel('模型').fill('draft-model')
  await page.getByRole('button', { name: '测试连接' }).click()

  await expect(page.getByText('当前页面配置测试通过，可使用 draft-model。', { exact: true })).toBeVisible()
  expect(testRequests).toEqual([
    {
      provider: 'draft-gateway',
      model: 'draft-model',
      settingsNs: 'llm-pi-ai',
      apiKey: 'unsaved-draft-key',
      baseURL: 'https://draft.example.test/v1',
      api: 'openai-completions',
      models: [{ id: 'draft-model' }],
    },
  ])
  expect(saveRequests).toEqual([])
  await expect(page.getByLabel('API 密钥')).toHaveValue('unsaved-draft-key')
  await expect(page.getByLabel('模型')).toHaveValue('draft-model')
  expect(failures, failures.join('\n')).toEqual([])
})

test('DSH extension settings load the official native surface and generic fallback from the production bundle', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings?tab=dsh-extensions')

  await expect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('内置', { exact: true }).first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText('已验证支持')
  await expect(page.locator('body')).not.toContainText('未完整验证')
  await expect(page.locator('body')).not.toContainText('未评估归属')
  await expect(page.locator('[data-dsh-native-surface]')).toBeVisible()
  await expect(page.locator('[data-dsh-native-surface]')).toContainText(/Web search|网页搜索/u)
  await page.getByRole('tab', { name: '通用配置' }).click()
  await expect(page.getByText('Namespace：web-search-deepseek', { exact: true })).toBeVisible()
  await expect(page.getByLabel('新的凭据值')).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('新的凭据值')).toHaveAttribute('autocomplete', 'off')

  expect(failures, failures.join('\n')).toEqual([])
})

test('settings saves a built-in provider credential without exposing it again', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installDeepSeekProviderRoutes(page)
  await page.goto('/settings')

  await page.getByRole('button', { name: /DeepSeek/u }).click()
  const apiKey = page.getByLabel('API 密钥')
  await apiKey.fill('playwright-write-only-test-key')
  await page.getByRole('button', { name: '保存供应商', exact: true }).click()
  await expect(page.getByText('供应商配置已保存。API 密钥只写入本机凭据存储。', { exact: true })).toBeVisible()
  await expect(apiKey).toHaveValue('')

  await page.reload()
  await page.getByRole('button', { name: /DeepSeek/u }).click()
  await expect(page.getByText('API 密钥已保存', { exact: true })).toBeVisible()
  await expect(page.getByLabel('API 密钥')).toHaveValue('')
  expect(failures, failures.join('\n')).toEqual([])
})

test('adding a connection selects a platform before showing its fields', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/connections')

  await page
    .getByRole('link', { name: /内置频道/u })
    .first()
    .click()
  await expect(page.getByText('内置频道由 NekroNXT 直接提供。')).toBeVisible()
  await expect(page.getByLabel('Client Secret')).toHaveCount(0)

  await page.getByRole('link', { name: '添加平台连接' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '选择平台' })).toBeVisible()
  await expect(dialog.getByText('选择要连接的平台账号。')).toBeVisible()
  await dialog.getByLabel('平台').click()
  await expect(page.getByRole('option', { name: 'QQ 官方机器人' })).toBeVisible()
  await expect(page.getByRole('option', { name: '企业微信智能机器人' })).toBeVisible()
  await page.getByRole('option', { name: '企业微信智能机器人' }).click()
  await expect(dialog.getByLabel('App ID')).toHaveCount(0)

  await dialog.getByRole('button', { name: '填写连接信息' }).click()
  await expect(dialog.getByRole('heading', { name: '配置 企业微信智能机器人' })).toBeVisible()
  await expect(dialog.getByLabel('连接别名')).toBeVisible()
  await dialog.getByLabel('连接别名').fill('旅程测试连接')
  await expect(dialog.getByLabel('BotID')).toBeVisible()
  await expect(dialog.getByLabel('Secret')).toHaveAttribute('type', 'password')
  await expect(dialog.getByLabel('Secret')).toHaveAttribute('autocomplete', 'off')
  await expect(dialog.getByLabel('平台')).toHaveCount(0)
  expect(failures, failures.join('\n')).toEqual([])
})

test('a verified Adapter can install, create a schema-backed connection, roll back, and uninstall without losing facts', async ({
  page,
  request,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const extensionId = ExtensionIdSchema.parse('ext_adapterjourney')
  const revisionV1 = ExtensionRevisionIdSchema.parse('xrv_adapterjourneyv1')
  const revisionV2 = ExtensionRevisionIdSchema.parse('xrv_adapterjourneyv2')
  const connectionId = ConnectionIdSchema.parse('con_adapterjourney')
  const channelId = ChannelIdSchema.parse('chn_adapterjourney')
  let installedRevisionId: ExtensionRevisionId | undefined
  let connectionCreated = false
  const installationRequests: string[] = []
  const connectionRequests: unknown[] = []
  const descriptor = {
    key: 'synthetic-chat',
    displayName: '合成聊天平台',
    description: '离线产品旅程使用的虚构聊天平台。',
    userCreatable: true,
    aliasEditable: true,
    channelDiscovery: 'adapter-observed' as const,
    diagnostics: { receive: true, send: true },
    configSchema: {
      schemaVersion: 1,
      type: 'object' as const,
      required: ['workspace', 'token'],
      properties: {
        workspace: { type: 'string' as const, title: '工作区', default: 'journey-room' },
        token: {
          type: 'credential-reference' as const,
          credentialKey: 'token',
          title: '访问令牌',
        },
      },
    },
  }
  const revision = (id: ExtensionRevisionId, revisionNumber: number, createdAt: number) => ({
    id,
    revisionNumber,
    createdAt,
    scope: 'host-adapter' as const,
    contributions: ['适配器：synthetic-chat'],
    verification: {
      verifiedAt: createdAt,
      dshVersion: '0.1.1-rc.2',
      contractVersion: 'nekro-nxt-extension-v2',
      hostBuilt: true,
      clientBuilt: false,
      buildKey: String(revisionNumber).repeat(64),
      toolInvocationCount: 0,
      rpcMethods: [],
      renderedSlots: [],
      renderedHostSlots: [],
      adapter: {
        apiVersion: 1 as const,
        key: 'synthetic-chat',
        descriptorDigest: 'a'.repeat(64),
        registered: true,
        started: true,
        stopped: true,
        inboundCommitted: true,
        outboundReceipt: 'sent' as const,
      },
    },
  })
  const snapshot = () =>
    HostApiContracts.snapshot.response.parse({
      ...baseSnapshot,
      connectionAdapters: installedRevisionId
        ? [...baseSnapshot.connectionAdapters, descriptor]
        : baseSnapshot.connectionAdapters,
      connections: connectionCreated
        ? [
            ...baseSnapshot.connections,
            {
              id: connectionId,
              adapterKey: 'synthetic-chat',
              alias: '旅程合成连接',
              status: installedRevisionId
                ? { state: 'connected', credentialConfigured: true, proactiveSend: true }
                : {
                    state: 'stopped',
                    message: '这个连接的适配器未安装。',
                    credentialConfigured: true,
                    proactiveSend: true,
                  },
              channelCount: 1,
              knownChannels: [{ id: channelId, name: '合成演示频道', kind: 'group' as const }],
            },
          ]
        : baseSnapshot.connections,
      channels: connectionCreated
        ? [
            ...baseSnapshot.channels,
            {
              id: channelId,
              connectionId,
              platformChannelId: 'synthetic-room',
              kind: 'group' as const,
              displayName: '合成演示频道',
              bindings: [],
            },
          ]
        : baseSnapshot.channels,
      extensions: [
        ...baseSnapshot.extensions.filter((item) => item.id !== extensionId),
        {
          id: extensionId,
          slug: 'synthetic-chat-adapter',
          displayName: '合成聊天适配器',
          description: '验证适配器本机安装、版本切换和卸载保留语义。',
          revisions: [revision(revisionV1, 1, 1_725_000_000_000), revision(revisionV2, 2, 1_725_000_001_000)],
          activations: [],
          ...(installedRevisionId
            ? { installation: { extensionRevisionId: installedRevisionId, installedAt: 1_725_000_002_000 } }
            : {}),
          clientDiagnostics: [],
        },
      ],
    })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }),
  )
  await page.route(`**/api/extensions/${extensionId}/installation`, async (route) => {
    if (route.request().method() === 'DELETE') {
      installedRevisionId = undefined
      installationRequests.push('uninstall')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uninstalled: true }),
      })
    }
    const body = HostApiContracts.installHostExtension.request.parse(route.request().postDataJSON())
    installedRevisionId = body.revisionId === revisionV1 ? revisionV1 : revisionV2
    installationRequests.push(installedRevisionId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        installation: { extensionId, extensionRevisionId: installedRevisionId, installedAt: 1_725_000_002_000 },
      }),
    })
  })
  await page.route('**/api/connections', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = HostApiContracts.createConnection.request.parse(route.request().postDataJSON())
    connectionRequests.push(body)
    expect(body.configuration).toEqual({ workspace: 'journey-room' })
    expect(body.credentials).toEqual({ token: 'synthetic-secret' })
    expect(body.configuration).not.toHaveProperty('token')
    connectionCreated = true
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ connectionId, adapterKey: 'synthetic-chat' }),
    })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/extensions/${extensionId}`)
  await expect(page.getByRole('heading', { name: '合成聊天适配器' })).toBeVisible()
  await expect(page.getByText('尚未安装', { exact: true }).first()).toBeVisible()
  const version2 = page.getByRole('listitem').filter({ hasText: '版本 2' })
  await version2.getByRole('button', { name: '安装到本机' }).click()
  await expect(page.getByText('已安装到本机', { exact: true })).toBeVisible()
  expect(installationRequests).toEqual([revisionV2])

  await page.goto('/connections?create=1&adapter=synthetic-chat')
  const createDialog = page.getByRole('dialog')
  await expect(createDialog.getByRole('heading', { name: '配置 合成聊天平台' })).toBeVisible()
  await createDialog.getByLabel('访问令牌').fill('synthetic-secret')
  await createDialog.getByRole('button', { name: '创建连接' }).click()
  await expect(page.getByText('连接已创建', { exact: true })).toBeVisible()
  expect(connectionRequests).toHaveLength(1)
  await page.goto(`/connections/${connectionId}`)
  await expect(page.getByRole('heading', { name: '旅程合成连接' })).toBeVisible()
  await page.getByRole('button', { name: '收发测试' }).click()
  await expect(page.getByLabel('测试消息发送到')).toContainText('合成演示频道 · 群聊')

  await page.goto(`/extensions/${extensionId}`)
  await page.getByRole('listitem').filter({ hasText: '版本 1' }).getByRole('button', { name: '回滚到此版本' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: '版本 1' })).toContainText('当前已安装')
  await version2.getByRole('button', { name: '更新到此版本' }).click()
  await expect(version2).toContainText('当前已安装')
  expect(installationRequests).toEqual([revisionV2, revisionV1, revisionV2])

  await expect(page.locator('html[data-nxt-view-transition]')).toHaveCount(0)
  const stage = page.locator('main')
  const pageBox = await stage.boundingBox()
  const includedBox = await page.getByText('包含内容', { exact: true }).locator('..').boundingBox()
  if (!pageBox || !includedBox) throw new Error('适配器扩展页缺少视觉验收区域。')
  expect(await stage.evaluate((element) => element.scrollLeft)).toBe(0)
  expect(includedBox.x).toBeGreaterThanOrEqual(pageBox.x)

  const installedScreenshot = testInfo.outputPath('adapter-installed.png')
  await page.screenshot({ path: installedScreenshot, animations: 'disabled' })
  await testInfo.attach('adapter-installed', { path: installedScreenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: '卸载', exact: true }).click()
  const uninstallDialog = page.getByRole('alertdialog')
  await expect(uninstallDialog).toContainText('连接、频道和历史会保留')
  const dialogScreenshot = testInfo.outputPath('adapter-uninstall-confirmation.png')
  await page.screenshot({ path: dialogScreenshot, animations: 'disabled' })
  await testInfo.attach('adapter-uninstall-confirmation', { path: dialogScreenshot, contentType: 'image/png' })
  await uninstallDialog.getByRole('button', { name: '卸载适配器' }).click()
  await expect(page.getByText('尚未安装', { exact: true }).first()).toBeVisible()
  expect(installationRequests.at(-1)).toBe('uninstall')

  await page.goto(`/connections/${connectionId}`)
  await expect(page.getByText('这个连接的适配器未安装。')).toBeVisible()
  await expect(page.getByText('已发现频道', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText(
    '1 个',
  )
  const retainedScreenshot = testInfo.outputPath('adapter-uninstalled-connection-retained.png')
  await page.screenshot({ path: retainedScreenshot, animations: 'disabled' })
  await testInfo.attach('adapter-uninstalled-connection-retained', {
    path: retainedScreenshot,
    contentType: 'image/png',
  })
  expect(failures, failures.join('\n')).toEqual([])
})

test("an intelligent-agent can add another channel while replacing that channel's previous agent", async ({
  page,
  request,
}) => {
  const failures = installRuntimeFailureGate(page)
  const runId = Date.now().toString(36)
  const sourceName = `绑定来源-${runId}`
  const targetName = `绑定目标-${runId}`
  const sourcePlan = {
    agentId: AgentIdSchema.parse('agt_journeysource'),
    revisionId: AgentRevisionIdSchema.parse('arev_journeysource'),
    channelId: ChannelIdSchema.parse('chn_journeysource'),
    displayName: sourceName,
  }
  const targetPlan = {
    agentId: AgentIdSchema.parse('agt_journeytarget'),
    revisionId: AgentRevisionIdSchema.parse('arev_journeytarget'),
    channelId: ChannelIdSchema.parse('chn_journeytarget'),
    displayName: targetName,
  }
  const plans = [sourcePlan, targetPlan] as const
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const webConnection = baseSnapshot.connections.find((connection) => connection.adapterKey === 'web')
  if (!webConnection) throw new Error('测试快照缺少 Web 连接。')
  let snapshot: HostSnapshot = {
    ...baseSnapshot,
    models: baseSnapshot.models.some((model) => model.provider === 'deepseek' && model.id === 'deepseek-v4-flash')
      ? baseSnapshot.models
      : [
          ...baseSnapshot.models,
          { provider: 'deepseek', providerName: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        ],
  }
  let created = 0

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    const channel = snapshot.channels.find((item) => item.id === channelId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        ...(channel?.boundAgentId === undefined ? {} : { agentId: channel.boundAgentId }),
        phase: channel?.runtimePhase ?? 'idle',
        summary: channel?.boundAgentId ? '智能体当前空闲。' : '尚未绑定智能体。',
        pendingInjectCount: 0,
        turns: [],
      }),
    })
  })
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const plan = plans[created]
    if (!plan) throw new Error('测试只允许创建两个智能体。')
    const rawRequest: unknown = route.request().postDataJSON()
    const input = HostApiContracts.createAgent.request.parse(rawRequest)
    if (input.displayName !== plan.displayName) throw new Error('创建智能体顺序与测试计划不一致。')
    const agent: HostSnapshot['agents'][number] = {
      id: plan.agentId,
      displayName: input.displayName,
      persona: input.persona,
      personaDocument: input.personaDocument ?? {
        version: 1,
        segments: input.persona ? [{ type: 'text', text: input.persona }] : [],
      },
      currentRevisionId: plan.revisionId,
      createdAt: 1_725_000_000_000 + created * 100,
      runtimeStatus: 'idle',
      runtimePhase: 'idle',
      model: input.model,
      dynamicClientApprovalPolicy: input.dynamicClientApprovalPolicy ?? 'manual',
      imagePolicy: input.imagePolicy ?? {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
      imageDiagnostics: {
        route: { mode: 'unavailable' },
        activeSessions: 0,
        residentImages: 0,
        duplicateImagesSkipped: 0,
        blockers: ['主模型没有声明图片输入能力，且未配置辅助视觉模型。'],
      },
      capabilities: input.capabilities ?? {
        subagents: true,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [plan.channelId],
    }
    const channel: HostSnapshot['channels'][number] = {
      id: plan.channelId,
      connectionId: webConnection.id,
      platformChannelId: `journey-${created}`,
      kind: 'web',
      displayName: `${plan.displayName} 的内置频道`,
      boundAgentId: plan.agentId,
      runtimePhase: 'idle',
      bindings: [
        {
          channelId: plan.channelId,
          agentId: plan.agentId,
          triggerPolicy: 'always',
          processingFeedback: 'auto',
          eventTriggers: [],
          boundAt: 1_725_000_000_000 + created * 100,
        },
      ],
    }
    snapshot = {
      ...snapshot,
      agents: [...snapshot.agents, agent],
      channels: [...snapshot.channels, channel],
      connections: snapshot.connections.map((connection) =>
        connection.id === webConnection.id ? { ...connection, channelCount: connection.channelCount + 1 } : connection,
      ),
    }
    created += 1
    const response = HostApiContracts.createAgent.response.parse({
      agentId: plan.agentId,
      channelId: plan.channelId,
      connectionId: webConnection.id,
    })
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(response) })
  })
  await page.route('**/api/bindings', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const rawRequest: unknown = route.request().postDataJSON()
    const input = HostApiContracts.createBinding.request.parse(rawRequest)
    const binding = HostApiContracts.createBinding.response.parse({
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: input.triggerPolicy,
      boundAt: 1_725_000_001_000,
    })
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) =>
        agent.id !== input.agentId || agent.channels.includes(input.channelId)
          ? agent
          : { ...agent, channels: [...agent.channels, input.channelId] },
      ),
      channels: snapshot.channels.map((channel) =>
        channel.id === input.channelId ? { ...channel, boundAgentId: input.agentId, bindings: [binding] } : channel,
      ),
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(binding) })
  })

  await page.goto('/work')
  const createAgent = async (displayName: string): Promise<{ agentId: string; channelId: string }> => {
    const result = await page.evaluate(
      async (input) => {
        const response = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        const body: unknown = await response.json()
        return { status: response.status, body }
      },
      {
        displayName,
        persona: '',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
    )
    expect(result.status).toBe(201)
    const responseBody: unknown = result.body
    return HostApiContracts.createAgent.response.parse(responseBody)
  }
  const source = await createAgent(sourceName)
  const target = await createAgent(targetName)

  await page.goto(`/work/agents/${target.agentId}`)
  await page.getByRole('button', { name: '绑定频道' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新增频道绑定' })).toBeVisible()
  await dialog.getByLabel('频道').click()
  await page.getByRole('option', { name: `内置频道 · ${sourceName} 的内置频道`, exact: true }).click()
  await dialog.getByLabel('响应方式').click()
  await page.getByRole('option', { name: '仅观察' }).click()
  await dialog.getByRole('button', { name: '绑定频道' }).click()

  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await expect(page.getByText(`${sourceName} 的内置频道`, { exact: true }).first()).toBeVisible()
  const currentResponse = await page.evaluate(async () => {
    const response = await fetch('/api/snapshot')
    const body: unknown = await response.json()
    return { status: response.status, body }
  })
  expect(currentResponse.status).toBe(200)
  const currentBody: unknown = currentResponse.body
  const currentSnapshot = HostApiContracts.snapshot.response.parse(currentBody)
  expect(currentSnapshot.agents.find((agent) => agent.id === target.agentId)?.channels).toEqual(
    expect.arrayContaining([target.channelId, source.channelId]),
  )
  expect(currentSnapshot.channels.find((channel) => channel.id === target.channelId)?.bindings).toEqual([
    expect.objectContaining({ agentId: target.agentId }),
  ])
  expect(currentSnapshot.channels.find((channel) => channel.id === source.channelId)?.bindings).toEqual([
    expect.objectContaining({ agentId: target.agentId, triggerPolicy: 'observe-only' }),
  ])
  expect(failures, failures.join('\n')).toEqual([])
})

test('connection workbench binds an intelligent-agent without visiting the manage page', async ({ page, request }) => {
  const failures = installRuntimeFailureGate(page)
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const agent =
    baseSnapshot.agents[0] ??
    ({
      id: AgentIdSchema.parse('agt_journeybind'),
      displayName: '绑定工作台',
      persona: '',
      personaDocument: { version: 1, segments: [] },
      currentRevisionId: AgentRevisionIdSchema.parse('arev_journeybind'),
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
      imageDiagnostics: {
        route: { mode: 'unavailable' },
        activeSessions: 0,
        residentImages: 0,
        duplicateImagesSkipped: 0,
        blockers: ['主模型没有声明图片输入能力，且未配置辅助视觉模型。'],
      },
      capabilities: {
        subagents: true,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [],
    } as const)
  const connectionId = ConnectionIdSchema.parse('con_journeyqq')
  const channelId = ChannelIdSchema.parse('chn_journeyqq')
  const qqChannel = {
    id: channelId,
    connectionId,
    platformChannelId: 'group:journey-qq',
    kind: 'group' as const,
    displayName: '绑定工作台群',
    bindings: [],
  }
  let snapshot: HostSnapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    agents: baseSnapshot.agents.some((item) => item.id === agent.id)
      ? baseSnapshot.agents
      : [...baseSnapshot.agents, agent],
    connectionAdapters: baseSnapshot.connectionAdapters.some((item) => item.key === 'qq-openclaw')
      ? baseSnapshot.connectionAdapters
      : [
          ...baseSnapshot.connectionAdapters,
          {
            key: 'qq-openclaw',
            displayName: 'QQ 官方机器人',
            description: '连接 QQ 机器人账号',
            userCreatable: true,
            aliasEditable: true,
            channelDiscovery: 'adapter-observed',
            diagnostics: { receive: true, send: true },
            configSchema: { schemaVersion: 1, type: 'object' as const, required: [], properties: {} },
          },
        ],
    connections: [
      ...baseSnapshot.connections.filter((item) => item.id !== connectionId),
      {
        id: connectionId,
        adapterKey: 'qq-openclaw',
        appId: '1000000000',
        proactiveSend: false,
        credentialConfigured: true,
        channelCount: 1,
        knownChannels: [{ id: channelId, name: '绑定工作台群', kind: 'group' }],
        gateway: { state: 'connected' },
        receiveTest: { status: 'received', channelId, platformMessageId: 'qq-received' },
        sendTest: { status: 'sent', channelId, platformMessageId: 'qq-sent' },
      },
    ],
    channels: [...baseSnapshot.channels.filter((item) => item.id !== channelId), qqChannel],
  })
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route('**/api/bindings', async (route) => {
    const rawRequest: unknown = route.request().postDataJSON()
    const input = HostApiContracts.createBinding.request.parse(rawRequest)
    const binding = HostApiContracts.createBinding.response.parse({
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: input.triggerPolicy,
      boundAt: 1_725_000_001_000,
    })
    snapshot = {
      ...snapshot,
      channels: snapshot.channels.map((item) =>
        item.id === input.channelId ? { ...item, boundAgentId: input.agentId, bindings: [binding] } : item,
      ),
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(binding) })
  })

  await page.goto('/connections')
  await page.getByRole('link', { name: /QQ 官方机器人/u }).click()
  await page.getByRole('button', { name: '绑定智能体' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '绑定智能体' })).toBeVisible()
  await expect(dialog).toContainText('选择响应这个频道的智能体和触发方式。保存后立即更新频道绑定。')
  await dialog.getByRole('button', { name: '绑定频道' }).click()
  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await expect(page).toHaveURL(/\/connections(?:\/|$)/u)
  await expect(page.getByRole('heading', { name: 'QQ 官方机器人' })).toBeVisible()
  expect(failures, failures.join('\n')).toEqual([])
})

test('external channel exposes processing feedback and per-event trigger controls', async ({ page, request }) => {
  const failures = installRuntimeFailureGate(page)
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const sourceAgent =
    baseSnapshot.agents[0] ??
    ({
      id: AgentIdSchema.parse('agt_onebotsettings'),
      displayName: '频道设置智能体',
      persona: '',
      personaDocument: { version: 1, segments: [] },
      currentRevisionId: AgentRevisionIdSchema.parse('arev_onebotsettings'),
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'idle',
      runtimePhase: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
      imageDiagnostics: {
        route: { mode: 'unavailable' },
        activeSessions: 0,
        residentImages: 0,
        duplicateImagesSkipped: 0,
        blockers: [],
      },
      capabilities: {
        subagents: true,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [],
    } as const)
  const connectionId = ConnectionIdSchema.parse('con_onebotsettings')
  const channelId = ChannelIdSchema.parse('chn_onebotsettings')
  let binding = HostApiContracts.createBinding.response.parse({
    channelId,
    agentId: sourceAgent.id,
    triggerPolicy: 'always',
    processingFeedback: 'auto',
    eventTriggers: [],
    boundAt: 1_725_000_000_000,
  })
  let snapshot: HostSnapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    connectionAdapters: baseSnapshot.connectionAdapters.some(({ key }) => key === 'onebot-11')
      ? baseSnapshot.connectionAdapters
      : [
          ...baseSnapshot.connectionAdapters,
          {
            key: 'onebot-11',
            displayName: 'OneBot 11',
            description: '连接独立部署的 OneBot 11 协议端',
            userCreatable: true,
            aliasEditable: true,
            channelDiscovery: 'adapter-observed',
            diagnostics: { receive: true, send: true },
            configSchema: { schemaVersion: 1, type: 'object' as const, required: [], properties: {} },
          },
        ],
    agents: (baseSnapshot.agents.some(({ id }) => id === sourceAgent.id)
      ? baseSnapshot.agents
      : [...baseSnapshot.agents, sourceAgent]
    ).map((agent) =>
      agent.id === sourceAgent.id ? { ...agent, channels: [...new Set([...agent.channels, channelId])] } : agent,
    ),
    connections: [
      ...baseSnapshot.connections.filter(({ id }) => id !== connectionId),
      {
        id: connectionId,
        adapterKey: 'onebot-11',
        alias: '测试协议端',
        status: {
          state: 'connected',
          credentialConfigured: true,
          proactiveSend: true,
          accountId: 'fixture-account',
          implementation: { name: 'Fixture', version: '1.0.0', protocolVersion: 'v11' },
          optionalCapabilities: { set_msg_emoji_like: 'available', send_poke: 'unknown' },
        },
        channelCount: 1,
        knownChannels: [{ id: channelId, name: '外部群聊', kind: 'group' }],
      },
    ],
    channels: [
      ...baseSnapshot.channels.filter(({ id }) => id !== channelId),
      {
        id: channelId,
        connectionId,
        platformChannelId: 'group:fixture-settings',
        kind: 'group',
        displayName: '外部群聊',
        boundAgentId: sourceAgent.id,
        runtimePhase: 'idle',
        bindings: [binding],
      },
    ],
  })
  const bindingRequests: unknown[] = []
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route(`**/api/channels/${channelId}/messages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], hasMore: false }),
    }),
  )
  await page.route(`**/api/channels/${channelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channelId, phase: 'idle', pendingInjectCount: 0, turns: [] }),
    }),
  )
  await page.route('**/api/bindings', async (route) => {
    const input = HostApiContracts.createBinding.request.parse(route.request().postDataJSON())
    bindingRequests.push(input)
    binding = HostApiContracts.createBinding.response.parse({ ...input, boundAt: binding.boundAt + 1 })
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      channels: snapshot.channels.map((channel) =>
        channel.id === channelId ? { ...channel, bindings: [binding] } : channel,
      ),
    })
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(binding) })
  })

  await page.goto(`/work/channels/${channelId}`)
  const inspector = page.getByLabel('频道')
  const feedback = inspector.getByRole('switch', { name: '显示处理中状态' })
  await expect(feedback).toBeChecked()
  await feedback.click()
  await expect(page.getByText('频道事件设置已更新。')).toBeVisible()
  await inspector.getByRole('button', { name: '设置特殊事件' }).click()
  for (const label of ['进入会话', '卡片操作', '正向反馈', '负向反馈', '撤销反馈']) {
    await expect(inspector.getByRole('switch', { name: label })).toBeVisible()
  }
  const poke = inspector.getByRole('switch', { name: '戳一戳' })
  await expect(poke).not.toBeChecked()
  await poke.click()
  await expect(poke).toBeChecked()
  const negativeFeedback = inspector.getByRole('switch', { name: '负向反馈' })
  await negativeFeedback.click()
  await expect(negativeFeedback).toBeChecked()
  expect(bindingRequests).toEqual([
    expect.objectContaining({ processingFeedback: 'off', eventTriggers: [] }),
    expect.objectContaining({ processingFeedback: 'off', eventTriggers: ['member-poked'] }),
    expect.objectContaining({
      processingFeedback: 'off',
      eventTriggers: ['member-poked', 'message-feedback-negative'],
    }),
  ])
  expect(failures, failures.join('\n')).toEqual([])
})

test('channel context controls and intelligent-agent deletion are guarded and remain usable while running', async ({
  page,
  request,
}) => {
  const failures = installRuntimeFailureGate(page)
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const connection = baseSnapshot.connections.find((item) => item.adapterKey === 'web')
  if (!connection) throw new Error('测试快照缺少 Web 连接。')
  const agentId = AgentIdSchema.parse('agt_contextjourney')
  const revisionId = AgentRevisionIdSchema.parse('arev_contextjourney')
  const channelId = ChannelIdSchema.parse('chn_contextjourney')
  const externalChannelId = ChannelIdSchema.parse('chn_externalremovejourney')
  let episodeId = EpisodeIdSchema.parse('eps_contextjourney')
  const agentName = '上下文旅程智能体'
  let snapshot: HostSnapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    agents: [
      ...baseSnapshot.agents.filter((item) => item.id !== agentId),
      {
        id: agentId,
        displayName: agentName,
        persona: '',
        personaDocument: { version: 1, segments: [] },
        currentRevisionId: revisionId,
        createdAt: 1_725_000_000_000,
        runtimeStatus: 'running',
        runtimePhase: 'using-tool',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        dynamicClientApprovalPolicy: 'manual',
        imagePolicy: {
          history: {
            mode: 'persistent-distinct',
            detail: 'auto',
            restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
          },
          textModel: { mode: 'disabled' },
        },
        imageDiagnostics: {
          route: { mode: 'unavailable' },
          activeSessions: 1,
          residentImages: 0,
          duplicateImagesSkipped: 0,
          blockers: [],
        },
        capabilities: {
          subagents: true,
          fileTools: false,
          webSearch: false,
          dynamicCreation: false,
          developmentShell: false,
          unrestrictedFileAccess: false,
        },
        channels: [channelId],
      },
    ],
    channels: [
      ...baseSnapshot.channels.filter((item) => item.id !== channelId),
      {
        id: channelId,
        connectionId: connection.id,
        platformChannelId: 'journey-context',
        kind: 'web',
        displayName: '上下文旅程频道',
        boundAgentId: agentId,
        runtimePhase: 'using-tool',
        bindings: [
          {
            channelId,
            agentId,
            triggerPolicy: 'always',
            boundAt: 1_725_000_000_000,
          },
        ],
      },
      {
        id: externalChannelId,
        connectionId: connection.id,
        platformChannelId: 'journey-external-remove',
        kind: 'group',
        displayName: '待移除的外部频道',
        runtimePhase: 'idle',
        bindings: [],
      },
    ],
    workTreeOrder: {
      agentIds: [agentId],
      channelIdsByAgent: { [agentId]: [channelId] },
      unboundChannelIds: [externalChannelId],
    },
  })
  const resetRequests: unknown[] = []
  const deleteRequests: unknown[] = []
  const channelDeleteRequests: unknown[] = []

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route(`**/api/channels/${channelId}/messages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], hasMore: false }),
    }),
  )
  await page.route(`**/api/channels/${channelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        agentId,
        episodeId,
        phase: 'using-tool',
        summary: '智能体正在使用工具。',
        pendingInjectCount: 0,
        turns: [],
      }),
    }),
  )
  await page.route(`**/api/channels/${externalChannelId}/messages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], hasMore: false }),
    }),
  )
  await page.route(`**/api/channels/${externalChannelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId: externalChannelId,
        phase: 'idle',
        pendingInjectCount: 0,
        turns: [],
      }),
    }),
  )
  await page.route(`**/api/channels/${externalChannelId}`, async (route) => {
    const input = HostApiContracts.deleteChannel.request.parse(route.request().postDataJSON())
    channelDeleteRequests.push(input)
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      channels: snapshot.channels.filter((item) => item.id !== externalChannelId),
      workTreeOrder: { ...snapshot.workTreeOrder, unboundChannelIds: [] },
    })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channelId: externalChannelId, deleted: true }),
    })
  })
  await page.route(`**/api/channels/${channelId}/context-reset`, async (route) => {
    const input = HostApiContracts.resetChannelContext.request.parse(route.request().postDataJSON())
    resetRequests.push(input)
    const closedEpisodeId = episodeId
    episodeId = EpisodeIdSchema.parse('eps_contextjourneynext')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: input.mode, closedEpisodeId, nextEpisodeId: episodeId }),
    })
  })
  await page.route(`**/api/agents/${agentId}`, async (route) => {
    const input = HostApiContracts.deleteAgent.request.parse(route.request().postDataJSON())
    deleteRequests.push(input)
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      agents: snapshot.agents.filter((item) => item.id !== agentId),
      channels: snapshot.channels.filter((item) => item.id !== channelId),
      workTreeOrder: { agentIds: [], channelIdsByAgent: {}, unboundChannelIds: [] },
    })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agentId, deleted: true, unboundChannelIds: [], deletedChannelIds: [channelId] }),
    })
  })

  await page.goto(`/work/channels/${externalChannelId}`)
  const channelHeaderActions = page.locator('[data-conversation-header-actions]')
  await expect(channelHeaderActions.getByRole('button', { name: '绑定智能体' })).toHaveCount(0)
  await expect(channelHeaderActions.getByRole('button', { name: '频道操作' })).toHaveCount(0)
  const channelInspector = page.getByLabel('频道')
  await expect(channelInspector.getByText('尚未绑定智能体', { exact: true })).toBeVisible()
  await channelInspector.getByRole('button', { name: '移除' }).click()
  const channelDeleteDialog = page.getByRole('alertdialog')
  await expect(channelDeleteDialog.getByRole('heading', { name: '从 NekroNXT 移除此频道？' })).toBeVisible()
  await expect(channelDeleteDialog.getByText(/频道会解除绑定并从列表中移除/u)).toBeVisible()
  await channelDeleteDialog.getByRole('button', { name: '从 NekroNXT 移除' }).click()
  await expect(page).toHaveURL(/\/work(?:\/|$)/u)
  expect(channelDeleteRequests).toEqual([{ expectedBoundAgentId: null }])

  await page.goto(`/work/channels/${channelId}`)
  await page.getByRole('button', { name: '上下文操作' }).click()
  await page.getByRole('menuitem', { name: '压缩上下文' }).click()
  const compactDialog = page.getByRole('dialog')
  await expect(compactDialog.getByRole('heading', { name: '压缩当前上下文？' })).toBeVisible()
  await expect(compactDialog.getByText(/立即中止/u)).toBeVisible()
  await expect(compactDialog.getByText(/以摘要开始新上下文/u)).toBeVisible()
  await compactDialog.getByRole('button', { name: '压缩上下文' }).click()
  await expect(page.getByText('当前上下文已压缩并完成交接。')).toBeVisible()
  expect(resetRequests).toEqual([{ expectedEpisodeId: 'eps_contextjourney', mode: 'compact' }])

  await page.goto(`/work/agents/${agentId}`)
  await expect(page.getByRole('heading', { name: agentName, level: 1 })).toBeVisible()
  await expect(page.getByText(/删除智能体会停止所有频道运行/u)).toBeVisible()
  await page.getByRole('button', { name: '删除智能体' }).click()
  const deleteDialog = page.getByRole('alertdialog')
  const deleteButton = deleteDialog.getByRole('button', { name: '删除智能体' })
  await expect(deleteDialog.getByText(/历史配置、消息和审计记录用于追溯/u)).toBeVisible()
  await expect(deleteDialog.getByRole('switch', { name: '同时删除自动创建的内置频道' })).toBeChecked()
  await expect(deleteButton).toBeDisabled()
  await deleteDialog.getByLabel(`输入“${agentName}”以确认`).fill('错误名称')
  await expect(deleteButton).toBeDisabled()
  await deleteDialog.getByLabel(`输入“${agentName}”以确认`).fill(agentName)
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expect(page).toHaveURL(/\/work(?:\/|$)/u)
  expect(deleteRequests).toEqual([
    {
      expectedCurrentRevisionId: revisionId,
      confirmationName: agentName,
      deleteAutoCreatedBuiltInChannels: true,
    },
  ])
  expect(failures, failures.join('\n')).toEqual([])
})
