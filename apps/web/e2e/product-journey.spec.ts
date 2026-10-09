import { expect, test, type Page } from '@playwright/test'
import { installWorkspaceRoutes } from './fixtures/workspace.js'
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
        modelsCustomized: false,
        discoverable: true,
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

test('production bundle keeps every space usable and retired links land on 概览 without runtime errors', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  for (const route of [
    '/',
    '/live',
    '/channels',
    '/agents',
    '/agents/new',
    '/workshop',
    '/wiring',
    '/wiring/new',
    '/settings/models',
    '/settings/adapters',
    '/settings/dsh',
    '/settings/notifications',
    '/settings/appearance',
    '/settings/about',
  ]) {
    await page.goto(route)
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '概览' })).toBeVisible()
    await expect(page.locator('main')).not.toBeEmpty()
  }
  // Retired client routes (saved Desktop routes, old bookmarks) open the app and land on its home.
  for (const route of ['/work/channels/chn_retired', '/users', '/extensions/ext_retired', '/connections']) {
    await page.goto(route)
    await expect(page).toHaveURL(/\/live$/u)
    await expect(page.getByRole('heading', { name: '概览', level: 1 })).toBeVisible()
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
    await page.goto(`${origin}/settings/models`)
    await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
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
    await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
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

  await page.goto('/wiring')
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
  await expect(page.getByRole('heading', { name: '接线', level: 1 })).toBeVisible()
  expect(pageErrors, pageErrors.join('\n')).toEqual([])
})

test('settings exposes the provider editor and survives real navigation', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installDeepSeekProviderRoutes(page, true)
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings\/models$/u)

  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
  await page
    .getByRole('table', { name: '模型供应商' })
    .getByRole('row', { name: /DeepSeek/u })
    .click()
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('autocomplete', 'off')
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute('data-1p-ignore', 'true')
  // The "saved keys cannot be viewed" note lives behind the field's InfoTip.
  await page.getByRole('button', { name: '说明：API 密钥', exact: true }).click()
  await expect(page.getByRole('dialog').getByText(/已保存密钥无法查看/u)).toBeVisible()
  await page.keyboard.press('Escape')

  const sections = page.getByRole('complementary', { name: '设置' })
  await sections.getByRole('link', { name: '平台适配器' }).click()
  await expect(page.getByRole('heading', { name: '平台适配器', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toHaveCount(0)
  await expect(page.getByText('由 NekroNXT 直接提供，用于应用内对话。', { exact: true })).toBeVisible()

  const rail = page.getByRole('navigation', { name: '主导航' })
  await rail.getByRole('link', { name: '频道' }).click()
  await expect(page).toHaveURL(/\/channels/u)
  await rail.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible()
  expect(failures, failures.join('\n')).toEqual([])
})

test('notification settings present channels before events and save only after a change', async ({ page, request }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings/notifications')

  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible()
  const channelsHeading = page.getByRole('heading', { name: '渠道' })
  const eventsHeading = page.getByRole('heading', { name: '通知我' })
  expect((await channelsHeading.boundingBox())!.y).toBeLessThan((await eventsHeading.boundingBox())!.y)
  const system = page.getByRole('switch', { name: '系统通知' })
  await expect(system).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Bark' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '测试' }).first().click()
  await expect(page.getByText('测试通知已发出', { exact: true })).toBeVisible()
  // The Playwright data root persists between runs: flip the saved value, then restore it.
  const approval = page.getByRole('switch', { name: '创造任务等待确认运行' })
  const stored = HostApiContracts.snapshot.response.parse(await (await request.get('/api/snapshot')).json())
  const saved = stored.notificationSettings.events['dynamic-client-approval-requested'] === true
  await expect(approval).toBeChecked({ checked: saved })
  for (const expected of [!saved, saved]) {
    await approval.click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('通知设置已保存', { exact: true }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(approval).toBeChecked({ checked: expected })
  }
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
  await page.goto('/settings/models')
  await page.getByRole('button', { name: '添加供应商' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: '开始配置' }).click()
  await page.getByLabel('供应商名称').fill('Draft Gateway')
  await page.getByLabel('API 密钥', { exact: true }).fill('unsaved-draft-key')
  await page.getByLabel('API 地址').fill('https://draft.example.test/v1')
  await page.getByLabel('API 协议', { exact: true }).click()
  await page.getByRole('option', { name: 'openai-completions', exact: true }).click()
  await page.getByRole('button', { name: '添加模型' }).click()
  await page.getByRole('textbox', { name: '模型 ID' }).fill('draft-model')
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
      models: [{ id: 'draft-model', inputModalities: ['text'] }],
    },
  ])
  expect(saveRequests).toEqual([])
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-draft-key')
  await expect(page.getByRole('textbox', { name: '模型 ID' })).toHaveValue('draft-model')
  expect(failures, failures.join('\n')).toEqual([])
})

test('DSH extension settings use the NekroNXT configuration surface without loading native WebUI', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings/dsh')

  await expect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('内置', { exact: true }).first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText('已验证支持')
  await expect(page.locator('body')).not.toContainText('未完整验证')
  await expect(page.locator('body')).not.toContainText('未评估归属')
  await expect(page.locator('[data-dsh-native-surface]')).toHaveCount(0)
  await page
    .getByRole('table', { name: 'DSH 插件' })
    .getByRole('row', { name: /DeepSeek 网页搜索/u })
    .click()
  // Technical identity stays in the collapsed diagnostics.
  await expect(page.getByText('web-search-deepseek', { exact: true })).toBeHidden()
  await page.getByRole('button', { name: '诊断信息' }).first().click()
  await expect(page.getByText('web-search-deepseek', { exact: true })).toBeVisible()
  await expect(page.getByLabel('新的凭据值', { exact: true })).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('新的凭据值', { exact: true })).toHaveAttribute('autocomplete', 'off')

  expect(failures, failures.join('\n')).toEqual([])
})

test('settings saves a built-in provider credential without exposing it again', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installDeepSeekProviderRoutes(page)
  await page.goto('/settings/models')

  await page
    .getByRole('table', { name: '模型供应商' })
    .getByRole('row', { name: /DeepSeek/u })
    .click()
  const apiKey = page.getByLabel('API 密钥', { exact: true })
  await apiKey.fill('playwright-write-only-test-key')
  await page.getByRole('button', { name: '保存供应商', exact: true }).click()
  await expect(page.getByText('供应商配置已保存。API 密钥只写入本机凭据存储。', { exact: true })).toBeVisible()
  await expect(apiKey).toHaveValue('')

  // The address keeps the open provider, so a reload returns to the same page.
  await page.reload()
  await expect(page.getByText('API 密钥已保存', { exact: true })).toBeVisible()
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('')
  expect(failures, failures.join('\n')).toEqual([])
})

test('adding a connection selects a platform before showing its fields', async ({ page, request }) => {
  const failures = installRuntimeFailureGate(page)
  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const snapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    connectionAdapters: [
      ...baseSnapshot.connectionAdapters.filter(({ provisioning }) => provisioning === 'system-singleton'),
      {
        key: 'fixture-beta',
        displayName: '示例群聊平台',
        description: '连接示例群聊平台账号。',
        provisioning: 'user-created',
        aliasEditable: true,
        channelDiscovery: 'adapter-observed',
        channelKinds: ['direct', 'group'],
        activities: [],
        features: {},
        diagnostics: { receive: true, send: true },
        configSchema: { type: 'object', dict: {} },
      },
      {
        key: 'fixture-gamma',
        displayName: '示例协作平台',
        description: '连接示例协作平台账号。',
        provisioning: 'user-created',
        aliasEditable: true,
        channelDiscovery: 'adapter-observed',
        channelKinds: ['direct', 'group'],
        activities: [],
        features: {},
        diagnostics: { receive: true, send: true },
        configSchema: {
          type: 'object',
          dict: {
            workspaceCode: { type: 'string', meta: { description: '工作区代码', required: true } },
            secret: { type: 'string', meta: { description: '访问密钥', required: true, role: 'secret' } },
          },
        },
      },
    ],
  })
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.goto('/wiring')
  await page.getByRole('button', { name: '添加账号' }).click()
  await expect(page).toHaveURL(/\/wiring\/new$/u)
  await expect(page.getByRole('heading', { name: '添加平台账号' })).toBeVisible()
  await expect(page.getByRole('button', { name: /示例群聊平台/u })).toBeVisible()
  // System-managed platforms are not offered for new accounts.
  await expect(page.getByRole('button', { name: /^内置频道/u })).toHaveCount(0)
  await expect(page.getByLabel('工作区代码')).toHaveCount(0)
  await page.getByRole('button', { name: /示例协作平台/u }).click()
  await expect(page.getByRole('heading', { name: '添加示例协作平台账号' })).toBeVisible()
  await page.getByLabel('名称', { exact: true }).fill('旅程测试连接')
  await expect(page.getByLabel('工作区代码')).toBeVisible()
  await expect(page.getByLabel('访问密钥')).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('访问密钥')).toHaveAttribute('autocomplete', 'off')
  await page.getByRole('button', { name: '换一个平台' }).click()
  await expect(page.getByRole('heading', { name: '添加平台账号' })).toBeVisible()
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
    provisioning: 'user-created',
    channelKinds: ['direct', 'group'],
    activities: [],
    features: {},
    aliasEditable: true,
    channelDiscovery: 'adapter-observed' as const,
    diagnostics: { receive: true, send: true },
    configSchema: {
      type: 'object' as const,
      dict: {
        workspace: {
          type: 'string' as const,
          meta: { description: '工作区', required: true, default: 'journey-room' },
        },
        token: { type: 'string' as const, meta: { description: '访问令牌', required: true, role: 'secret' } },
      },
    },
  }
  const revision = (id: ExtensionRevisionId, revisionNumber: number, createdAt: number) => ({
    id,
    revisionNumber,
    createdAt,
    provides: ['adapter' as const],
    agentLayer: false,
    contributions: ['适配器：synthetic-chat'],
    verification: {
      verifiedAt: createdAt,
      dshVersion: '0.1.1-rc.2',
      contractVersion: 'nekro-nxt-extension-v5',
      hostBuilt: true,
      clientBuilt: false,
      buildKey: String(revisionNumber).repeat(64),
      toolInvocationCount: 0,
      rpcMethods: [],
      renderedPanels: [],
      renderedToolViews: [],
      renderedMessageRenderers: [],
      adapter: {
        apiVersion: 2 as const,
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
          provides: ['adapter'],
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
        installation: {
          extensionId,
          extensionRevisionId: installedRevisionId,
          installedAt: 1_725_000_002_000,
          config: {},
        },
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

  await installWorkspaceRoutes(page, snapshot)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/workshop/extensions/${extensionId}`)
  await expect(page.getByRole('heading', { name: '合成聊天适配器', level: 1 })).toBeVisible()
  await expect(page.getByText('未安装', { exact: true }).first()).toBeVisible()
  const version = page.getByRole('combobox', { name: '版本' })
  // Records list newest first: the first option is v2, the second v1.
  const pickRecord = async (position: number) => {
    await version.click()
    const option = page.getByRole('option').nth(position)
    const label = (await option.textContent()) ?? ''
    await option.click()
    return label
  }
  await pickRecord(0)
  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByText('已安装', { exact: true }).first()).toBeVisible()
  expect(installationRequests).toEqual([revisionV2])

  await page.goto('/wiring/new?adapter=synthetic-chat')
  await expect(page.getByRole('heading', { name: '添加合成聊天平台账号' })).toBeVisible()
  await expect(page.getByLabel('工作区')).toHaveValue('journey-room')
  await page.getByLabel('访问令牌').fill('synthetic-secret')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/wiring/connections/${connectionId}$`, 'u'))
  expect(connectionRequests).toHaveLength(1)
  const detail = page.getByRole('complementary', { name: '详情' })
  await expect(detail.getByRole('heading', { name: '旅程合成连接' })).toBeVisible()
  await expect(detail.getByRole('combobox', { name: '测试频道' })).toContainText('合成演示频道')

  await page.goto(`/workshop/extensions/${extensionId}`)
  const v1 = await pickRecord(1)
  await page.getByRole('button', { name: '切换到这个版本' }).click()
  await expect(version).toHaveText(`${v1} · 已安装`)
  await pickRecord(0)
  await page.getByRole('button', { name: '切换到这个版本' }).click()
  await expect(version).toHaveText(/ · 已安装$/u)
  await expect(version).not.toHaveText(`${v1} · 已安装`)
  await expect(page.locator('main')).not.toContainText(/(?:^|[^a-z_])r\d+(?:[^\d]|$)/u)
  expect(installationRequests).toEqual([revisionV2, revisionV1, revisionV2])
  expect(await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

  const installedScreenshot = testInfo.outputPath('adapter-installed.png')
  await page.screenshot({ path: installedScreenshot, animations: 'disabled' })
  await testInfo.attach('adapter-installed', { path: installedScreenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: '卸载', exact: true }).click()
  const uninstallDialog = page.getByRole('dialog')
  await expect(uninstallDialog).toContainText('连接、频道和消息保留')
  await uninstallDialog.getByRole('button', { name: '卸载', exact: true }).click()
  await expect(uninstallDialog).toBeHidden()
  await expect(page.getByText('未安装', { exact: true }).first()).toBeVisible()
  expect(installationRequests.at(-1)).toBe('uninstall')

  await page.goto(`/wiring/connections/${connectionId}`)
  await expect(detail).toContainText('这个连接的适配器未安装。')
  await expect(detail.getByRole('heading', { name: /频道 1/u })).toBeVisible()
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
  const internalDescriptor = baseSnapshot.connectionAdapters.find(
    ({ provisioning, channelKinds }) => provisioning === 'system-singleton' && channelKinds.includes('internal'),
  )
  const internalConnection = baseSnapshot.connections.find(
    (connection) => connection.adapterKey === internalDescriptor?.key,
  )
  if (!internalConnection) throw new Error('测试快照缺少内置连接。')
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
        cursor: { epoch: 'fixture', sequence: 0 },
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
        scheduledTasks: true,
      },
      channels: [plan.channelId],
      appearance: {},
    }
    const channel: HostSnapshot['channels'][number] = {
      id: plan.channelId,
      connectionId: internalConnection.id,
      platformChannelId: `journey-${created}`,
      kind: 'internal',
      displayName: `${plan.displayName} 的内置频道`,
      boundAgentId: plan.agentId,
      runtimePhase: 'idle',
      activity: { unreadCount: 0, unreadCapped: false },
      bindings: [
        {
          channelId: plan.channelId,
          agentId: plan.agentId,
          triggerPolicy: 'always',
          processingFeedback: 'auto',
          activityTriggerOverrides: {},
          boundAt: 1_725_000_000_000 + created * 100,
        },
      ],
    }
    snapshot = {
      ...snapshot,
      agents: [...snapshot.agents, agent],
      channels: [...snapshot.channels, channel],
      connections: snapshot.connections.map((connection) =>
        connection.id === internalConnection.id
          ? { ...connection, channelCount: connection.channelCount + 1 }
          : connection,
      ),
    }
    created += 1
    const response = HostApiContracts.createAgent.response.parse({
      agentId: plan.agentId,
      channelId: plan.channelId,
      connectionId: internalConnection.id,
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

  await installWorkspaceRoutes(page, () => snapshot)
  await page.goto('/live')
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

  await page.goto(`/agents/${target.agentId}`)
  await page.getByRole('button', { name: '添加频道' }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${sourceName} 的内置频道`, 'u') }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `让${targetName}响应「${sourceName} 的内置频道」` })).toBeVisible()
  await dialog.getByLabel('触发').click()
  await page.getByRole('option', { name: '仅观察', exact: true }).click()
  await dialog.getByRole('button', { name: '换绑' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(`「${sourceName} 的内置频道」已交给${targetName}`)).toBeVisible()
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
  expect(currentSnapshot.channels.find((channel) => channel.id === source.channelId)?.bindings).toEqual([
    expect.objectContaining({ agentId: target.agentId, triggerPolicy: 'observe-only' }),
  ])
  expect(failures, failures.join('\n')).toEqual([])
})

test('the wiring board binds an agent to an unwired channel in place', async ({ page, request }) => {
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
  const connectionId = ConnectionIdSchema.parse('con_journeyexternal')
  const channelId = ChannelIdSchema.parse('chn_journeyexternal')
  const externalChannel = {
    id: channelId,
    connectionId,
    platformChannelId: 'opaque-group-journey',
    kind: 'group' as const,
    displayName: '绑定工作台群',
    bindings: [],
  }
  let snapshot: HostSnapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    agents: baseSnapshot.agents.some((item) => item.id === agent.id)
      ? baseSnapshot.agents
      : [...baseSnapshot.agents, agent],
    connectionAdapters: baseSnapshot.connectionAdapters.some((item) => item.key === 'fixture-beta')
      ? baseSnapshot.connectionAdapters
      : [
          ...baseSnapshot.connectionAdapters,
          {
            key: 'fixture-beta',
            displayName: '示例群聊平台',
            description: '连接示例群聊平台账号',
            provisioning: 'user-created',
            channelKinds: ['direct', 'group'],
            activities: [],
            features: {},
            aliasEditable: true,
            channelDiscovery: 'adapter-observed',
            diagnostics: { receive: true, send: true },
            configSchema: { type: 'object' as const, dict: {} },
          },
        ],
    connections: [
      ...baseSnapshot.connections.filter((item) => item.id !== connectionId),
      {
        id: connectionId,
        adapterKey: 'fixture-beta',
        status: {
          state: 'connected',
          proactiveSend: false,
          credentialConfigured: true,
          accountReference: '示例账号',
          activities: {},
        },
        channelCount: 1,
        knownChannels: [{ id: channelId, name: '绑定工作台群', kind: 'group' }],
        receiveTest: { status: 'received', channelId, platformMessageId: 'fixture-received' },
        sendTest: { status: 'sent', channelId, platformMessageId: 'fixture-sent' },
      },
    ],
    channels: [...baseSnapshot.channels.filter((item) => item.id !== channelId), externalChannel],
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

  await installWorkspaceRoutes(page, () => snapshot)
  await page.goto(`/wiring/connections/${connectionId}`)
  await page.getByRole('button', { name: '把「绑定工作台群」接到智能体' }).click()
  const picker = page.getByRole('menu', { name: '为「绑定工作台群」选择智能体' })
  await picker.getByRole('menuitem', { name: `交给${agent.displayName}` }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `让${agent.displayName}响应「绑定工作台群」` })).toBeVisible()
  await dialog.getByRole('button', { name: '接线' }).click()
  await expect(page.getByText(`「绑定工作台群」已交给${agent.displayName}`)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/wiring/connections/${connectionId}$`, 'u'))
  expect(snapshot.channels.find((item) => item.id === channelId)?.bindings[0]?.agentId).toBe(agent.id)
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
      id: AgentIdSchema.parse('agt_activitysettings'),
      displayName: '频道设置智能体',
      persona: '',
      personaDocument: { version: 1, segments: [] },
      currentRevisionId: AgentRevisionIdSchema.parse('arev_activitysettings'),
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
  const connectionId = ConnectionIdSchema.parse('con_activitysettings')
  const channelId = ChannelIdSchema.parse('chn_activitysettings')
  // Another agent on this host answers the same group through its own account.
  const recorder = {
    ...sourceAgent,
    id: AgentIdSchema.parse('agt_activityrecorder'),
    displayName: '记录员',
    channels: [],
  }
  let binding = HostApiContracts.createBinding.response.parse({
    channelId,
    agentId: sourceAgent.id,
    triggerPolicy: 'always',
    processingFeedback: 'auto',
    activityTriggerOverrides: {},
    boundAt: 1_725_000_000_000,
  })
  let snapshot: HostSnapshot = HostApiContracts.snapshot.response.parse({
    ...baseSnapshot,
    connectionAdapters: baseSnapshot.connectionAdapters.some(({ key }) => key === 'fixture-beta')
      ? baseSnapshot.connectionAdapters
      : [
          ...baseSnapshot.connectionAdapters,
          {
            key: 'fixture-beta',
            displayName: '示例群聊平台',
            description: '连接示例群聊平台账号',
            provisioning: 'user-created',
            channelKinds: ['direct', 'group'],
            activities: [
              {
                key: 'member-poked',
                scope: 'channel',
                displayName: '轻触成员',
                description: '频道成员之间发生轻触互动。',
                triggerable: true,
                channelKinds: ['group'],
              },
              {
                key: 'message-feedback-negative',
                scope: 'channel',
                displayName: '负向反馈',
                description: '频道消息收到负向反馈。',
                triggerable: true,
                channelKinds: ['group'],
              },
              {
                key: 'account-profile-updated',
                scope: 'connection',
                displayName: '账号资料更新',
                description: '连接账号的资料发生变化。',
                triggerable: false,
              },
              {
                key: 'direct-only-activity',
                scope: 'channel',
                displayName: '私聊专属活动',
                description: '只适用于私聊频道。',
                triggerable: true,
                channelKinds: ['direct'],
              },
            ],
            features: { processingFeedback: { channelKinds: ['group'] } },
            aliasEditable: true,
            channelDiscovery: 'adapter-observed',
            diagnostics: { receive: true, send: true },
            configSchema: { type: 'object' as const, dict: {} },
          },
        ],
    agents: [
      ...(baseSnapshot.agents.some(({ id }) => id === sourceAgent.id)
        ? baseSnapshot.agents
        : [...baseSnapshot.agents, sourceAgent]),
      recorder,
    ].map((agent) =>
      agent.id === sourceAgent.id ? { ...agent, channels: [...new Set([...agent.channels, channelId])] } : agent,
    ),
    connections: [
      ...baseSnapshot.connections.filter(({ id }) => id !== connectionId),
      {
        id: connectionId,
        adapterKey: 'fixture-beta',
        alias: '测试协议端',
        activityTriggerDefaults: ['member-poked'],
        status: {
          state: 'connected',
          credentialConfigured: true,
          proactiveSend: true,
          accountReference: 'fixture-account',
          implementation: { name: 'Fixture', version: '1.0.0', protocolVersion: 'v11' },
          activities: {
            'member-poked': { state: 'available' },
            'message-feedback-negative': { state: 'available' },
            'account-profile-updated': { state: 'available' },
            'direct-only-activity': { state: 'available' },
          },
          processingFeedback: { state: 'available' },
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
        activity: { unreadCount: 0, unreadCapped: false },
        localAgentIds: [recorder.id],
        bindings: [binding],
      },
    ],
  })
  const bindingRequests: unknown[] = []
  const defaultRequests: unknown[] = []
  const deleteRequests: unknown[] = []
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route(`**/api/channels/${channelId}/messages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cursor: { epoch: 'fixture', sequence: 0 },
        messages: [
          {
            id: 'evt_recorderline',
            channelId,
            role: 'member',
            sender: { memberId: 'mbr_recorder', displayName: '记录号', localAgentId: recorder.id },
            parts: [{ type: 'text', text: '已记录今天的讨论。' }],
            occurredAt: 1_725_000_000_000,
          },
        ],
        hasMore: false,
      }),
    }),
  )
  await page.route(`**/api/channels/${channelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId,
        phase: 'idle',
        pendingInjectCount: 0,
        turns: [],
      }),
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
  await page.route(`**/api/connections/${connectionId}/activity-trigger-defaults`, async (route) => {
    const input = HostApiContracts.updateConnectionActivityTriggerDefaults.request.parse(route.request().postDataJSON())
    defaultRequests.push(input)
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      connections: snapshot.connections.map((connection) =>
        connection.id === connectionId ? { ...connection, activityTriggerDefaults: input.activityKeys } : connection,
      ),
    })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connectionId, activityKeys: input.activityKeys }),
    })
  })
  await page.route(`**/api/connections/${connectionId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const input = HostApiContracts.deleteConnection.request.parse(route.request().postDataJSON())
    deleteRequests.push(input)
    const removedConnection = snapshot.connections.find(({ id }) => id === connectionId)!
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      connections: snapshot.connections.filter(({ id }) => id !== connectionId),
      channels: snapshot.channels.filter(({ connectionId: ownerId }) => ownerId !== connectionId),
      archivedConnections: [
        ...snapshot.archivedConnections,
        {
          id: connectionId,
          adapterKey: removedConnection.adapterKey,
          alias: removedConnection.alias,
          channelCount: 1,
          archivedAt: Date.now(),
        },
      ],
    })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connectionId, archived: true }),
    })
  })
  await page.route(`**/api/connections/${connectionId}/restore`, async (route) => {
    snapshot = HostApiContracts.snapshot.response.parse({
      ...snapshot,
      connections: [
        ...snapshot.connections,
        {
          id: connectionId,
          adapterKey: 'fixture-beta',
          alias: '测试协议端',
          activityTriggerDefaults: [],
          status: {
            state: 'connected',
            credentialConfigured: true,
            proactiveSend: true,
            activities: {
              'member-poked': { state: 'available' },
              'message-feedback-negative': { state: 'available' },
              'account-profile-updated': { state: 'available' },
              'direct-only-activity': { state: 'available' },
            },
            processingFeedback: { state: 'available' },
          },
          channelCount: 1,
          knownChannels: [{ id: channelId, name: '外部群聊', kind: 'group' }],
        },
      ],
      archivedConnections: snapshot.archivedConnections.filter(({ id }) => id !== connectionId),
    })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connectionId, restored: true }),
    })
  })

  await installWorkspaceRoutes(page, () => snapshot)
  await page.goto(`/channels/${channelId}`)
  const inspector = page.getByRole('complementary', { name: '频道信息' })
  await expect(page.getByText('本机 · 记录员', { exact: true })).toBeVisible()
  const localAgents = inspector.getByRole('switch', { name: '回应本机智能体' })
  await expect(inspector.getByText('记录员也在这个群', { exact: true })).toBeVisible()
  await expect(localAgents).not.toBeChecked()
  await localAgents.click()
  await expect(localAgents).toBeChecked()
  await expect.poll(() => bindingRequests.at(-1)).toMatchObject({ localAgentMessages: 'trigger' })
  await localAgents.click()
  await expect(localAgents).not.toBeChecked()
  await expect.poll(() => bindingRequests.length).toBe(2)
  expect(bindingRequests.at(-1)).toMatchObject({ localAgentMessages: 'observe' })
  bindingRequests.length = 0
  const feedback = inspector.getByRole('switch', { name: '处理中反馈' })
  await expect(feedback).toBeChecked()
  await feedback.click()
  await expect(feedback).not.toBeChecked()
  await expect(inspector.getByText('跟随账号', { exact: true })).toBeVisible()
  await inspector.getByRole('button', { name: '展开特殊事件' }).click()
  for (const label of ['轻触成员', '负向反馈']) {
    await expect(inspector.getByRole('combobox', { name: label })).toBeVisible()
  }
  await expect(inspector.getByRole('combobox', { name: '账号资料更新' })).toHaveCount(0)
  await expect(inspector.getByRole('combobox', { name: '私聊专属活动' })).toHaveCount(0)
  const poke = inspector.getByRole('combobox', { name: '轻触成员' })
  const choose = async (field: typeof poke, label: string) => {
    await field.click()
    await page.getByRole('option', { name: label, exact: true }).click()
  }
  await expect(poke).toHaveText('跟随账号（触发）')
  await choose(poke, '不触发')
  const negativeFeedback = inspector.getByRole('combobox', { name: '负向反馈' })
  await expect(negativeFeedback).toHaveText('跟随账号（不触发）')
  await choose(negativeFeedback, '触发')
  await expect(inspector.getByText('2 项单独设置', { exact: true })).toBeVisible()
  await choose(poke, '跟随账号（触发）')
  await expect(inspector.getByText('1 项单独设置', { exact: true })).toBeVisible()
  expect(bindingRequests).toEqual([
    expect.objectContaining({ processingFeedback: 'off', activityTriggerOverrides: {} }),
    expect.objectContaining({ processingFeedback: 'off', activityTriggerOverrides: { 'member-poked': false } }),
    expect.objectContaining({
      processingFeedback: 'off',
      activityTriggerOverrides: { 'member-poked': false, 'message-feedback-negative': true },
    }),
    expect.objectContaining({
      processingFeedback: 'off',
      activityTriggerOverrides: { 'message-feedback-negative': true },
    }),
  ])

  await page.goto(`/wiring/connections/${connectionId}`)
  const detail = page.getByRole('complementary', { name: '详情' })
  const connectionDefault = detail.getByRole('switch', { name: '轻触成员' })
  await expect(connectionDefault).toBeChecked()
  await connectionDefault.click()
  await expect(connectionDefault).not.toBeChecked()
  await expect.poll(() => defaultRequests).toEqual([{ activityKeys: [] }])

  await detail.getByRole('button', { name: '删除连接' }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除「测试协议端」？' })
  await expect(deleteDialog.getByRole('switch', { name: '同时删除频道数据' })).not.toBeChecked()
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(() => deleteRequests).toEqual([{ deleteChannelData: false }])
  await expect(deleteDialog).toBeHidden()
  await page.goto('/wiring/new')
  const archived = page.getByText('测试协议端', { exact: true })
  await expect(archived).toBeVisible()
  await page.getByRole('button', { name: '恢复' }).click()
  await expect(page.getByText('账号已恢复', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/wiring/connections/${connectionId}$`, 'u'))
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
  const internalDescriptor = baseSnapshot.connectionAdapters.find(
    ({ provisioning, channelKinds }) => provisioning === 'system-singleton' && channelKinds.includes('internal'),
  )
  const connection = baseSnapshot.connections.find((item) => item.adapterKey === internalDescriptor?.key)
  if (!connection) throw new Error('测试快照缺少内置连接。')
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
        appearance: {},
      },
    ],
    channels: [
      ...baseSnapshot.channels.filter((item) => item.id !== channelId),
      {
        id: channelId,
        connectionId: connection.id,
        platformChannelId: 'journey-context',
        kind: 'internal',
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
        activity: { unreadCount: 0, unreadCapped: false },
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
      body: JSON.stringify({ cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false }),
    }),
  )
  await page.route(`**/api/channels/${channelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId,
        agentId,
        episodeId,
        phase: 'using-tool',
        summary: '智能体正在使用工具。',
        pendingInjectCount: 0,
        occupancy: {
          projectedTokens: 12_000,
          contextWindow: 128_000,
          breakdown: { systemTokens: 3_000, toolsTokens: 4_000, messageTokens: 5_000 },
        },
        turns: [],
      }),
    }),
  )
  const doc = (text: string) => ({ version: 1 as const, segments: [{ type: 'text' as const, text }] })
  let promptView = HostApiContracts.getChannelPrompt.response.parse({
    instructions: {
      document: doc('本频道只讨论旅程测试。'),
      locked: false,
      revision: 2,
      maxChars: 4000,
      updatedBy: 'admin',
      updatedAt: 1_725_000_100_000,
      revisions: [{ revision: 1, document: doc('最早的旅程说明。'), updatedBy: 'admin', updatedAt: 1_725_000_000_000 }],
    },
    notes: {
      document: doc('成员甲喜欢简短的回答。'),
      locked: false,
      revision: 1,
      maxChars: 2000,
      updatedBy: 'agent',
      updatedAt: 1_725_000_150_000,
      revisions: [],
    },
  })
  const promptSaves: unknown[] = []
  await page.route(`**/api/channels/${channelId}/runtime/context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        HostApiContracts.getChannelRuntimeContext.response.parse({
          available: true,
          route: { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 128_000, reasoningEffort: 'high' },
          instructions: [
            {
              role: 'system',
              text: '你是旅程测试智能体。\n频道消息、历史与交接中的时间统一写作宿主时区带偏移的绝对时间。',
              truncated: false,
            },
          ],
          tools: [
            {
              name: 'send_channel_message',
              description: '向触发当前对话的频道发送一条用户可见消息。',
              parameters: JSON.stringify({ type: 'object', required: ['target', 'parts'] }, null, 2),
            },
            { name: 'finish_channel_turn', description: '显式结束当前频道 Turn。' },
          ],
          changes: [
            { at: 1_725_000_000_000, reason: 'initial', toolCount: 1 },
            { at: 1_725_000_060_000, reason: 'change', toolCount: 2 },
          ],
        }),
      ),
    }),
  )
  await page.route(`**/api/channels/${externalChannelId}/messages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false }),
    }),
  )
  await page.route(`**/api/channels/${externalChannelId}/runtime`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cursor: { epoch: 'fixture', sequence: 0 },
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

  await installWorkspaceRoutes(page, () => snapshot)
  // Registered after the shared routes so it answers this channel's prompt.
  await page.route(`**/api/channels/${channelId}/prompt`, async (route) => {
    if (route.request().method() === 'PUT') {
      const input = HostApiContracts.updateChannelPrompt.request.parse(route.request().postDataJSON())
      promptSaves.push(input)
      const part = promptView[input.kind]
      promptView = HostApiContracts.getChannelPrompt.response.parse({
        ...promptView,
        [input.kind]: {
          ...part,
          document: input.document,
          locked: input.kind === 'notes' && input.locked,
          revision: part.revision + 1,
          updatedBy: 'admin',
          updatedAt: 1_725_000_200_000,
        },
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(promptView) })
  })
  await page.goto(`/channels/${externalChannelId}`)
  const inspector = page.getByRole('complementary', { name: '频道信息' })
  await expect(inspector.getByRole('combobox', { name: '智能体' })).toHaveText('选择智能体')
  await inspector.getByRole('button', { name: '移除频道' }).click()
  const channelDeleteDialog = page.getByRole('dialog', { name: '移除「待移除的外部频道」？' })
  await expect(channelDeleteDialog).toContainText('聊天记录保留')
  await channelDeleteDialog.getByRole('button', { name: '移除', exact: true }).click()
  await expect.poll(() => channelDeleteRequests).toEqual([{ expectedBoundAgentId: null }])
  await expect(page).not.toHaveURL(new RegExp(`/channels/${externalChannelId}$`, 'u'))

  await page.goto(`/channels/${channelId}`)
  await expect(inspector.getByText('本频道只讨论旅程测试。', { exact: false })).toBeVisible()
  await expect(inspector.getByText('智能体笔记 11 字', { exact: false })).toBeVisible()
  await inspector.getByRole('button', { name: '编辑', exact: true }).click()
  const promptSheet = page.getByRole('dialog', { name: '「上下文旅程频道」的频道说明' })
  const promptEditor = promptSheet.getByRole('textbox', { name: '频道说明' })
  await expect(promptEditor).toContainText('本频道只讨论旅程测试。')
  await promptSheet.getByText('之前的版本 1').click()
  await promptSheet.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(promptEditor).toContainText('最早的旅程说明。')
  await promptEditor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('回答保持简短。')
  const notesField = promptSheet.getByRole('textbox', { name: '智能体笔记' })
  await expect(notesField).toHaveValue('成员甲喜欢简短的回答。')
  await notesField.fill('成员甲喜欢简短的回答。不要用表情包。')
  await promptSheet.getByRole('switch', { name: '锁定智能体笔记' }).click()
  await promptSheet.getByRole('button', { name: '保存', exact: true }).click()
  await expect(promptSheet).toHaveCount(0)
  expect(promptSaves).toEqual([
    {
      kind: 'instructions',
      document: doc('最早的旅程说明。回答保持简短。'),
      locked: false,
      expectedRevision: 2,
    },
    { kind: 'notes', document: doc('成员甲喜欢简短的回答。不要用表情包。'), locked: true, expectedRevision: 1 },
  ])
  await expect(inspector.getByText('（已锁定）', { exact: false })).toBeVisible()
  await inspector.getByRole('button', { name: '查看', exact: true }).click()
  const contextSheet = page.getByRole('dialog', { name: `${agentName}看到的上下文` })
  await expect(contextSheet.getByText('deepseek-v4-flash')).toBeVisible()
  await expect(contextSheet.getByText('你是旅程测试智能体。', { exact: false })).toBeVisible()
  await expect(contextSheet.getByRole('heading', { name: '工具 2' })).toBeVisible()
  await contextSheet.getByRole('button', { name: 'send_channel_message' }).click()
  await expect(contextSheet.getByText('向触发当前对话的频道发送一条用户可见消息。')).toBeVisible()
  await expect(contextSheet.getByText('工具或模型设置变化')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(contextSheet).toHaveCount(0)
  await inspector.getByRole('button', { name: '压缩', exact: true }).click()
  const compactDialog = page.getByRole('dialog', { name: '压缩上下文？' })
  await expect(compactDialog).toContainText('当前任务会停止，对话整理成摘要后继续。')
  await compactDialog.getByRole('button', { name: '压缩', exact: true }).click()
  await expect(page.getByText('已压缩上下文', { exact: true })).toBeVisible()
  expect(resetRequests).toEqual([{ expectedEpisodeId: 'eps_contextjourney', mode: 'compact' }])

  await page.goto(`/agents/${agentId}`)
  await expect(page.getByRole('heading', { name: agentName, exact: true, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除智能体' }).click()
  const deleteDialog = page.getByRole('dialog', { name: `删除${agentName}？` })
  await expect(deleteDialog).toContainText(`${agentName}会停止所有频道的工作`)
  await expect(deleteDialog.getByRole('switch', { name: '同时删除它的内置频道' })).toBeChecked()
  await expect(deleteDialog.getByRole('switch', { name: '同时删除工作区' })).not.toBeChecked()
  const confirmName = deleteDialog.getByLabel(`输入“${agentName}”确认`)
  await confirmName.fill('错误名称')
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(deleteDialog).toContainText('输入的名称不一致。')
  expect(deleteRequests).toEqual([])
  await confirmName.fill(agentName)
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect
    .poll(() => deleteRequests)
    .toEqual([
      {
        expectedCurrentRevisionId: revisionId,
        confirmationName: agentName,
        deleteAutoCreatedBuiltInChannels: true,
        deleteWorkspace: false,
      },
    ])
  await expect(page).not.toHaveURL(new RegExp(`/agents/${agentId}$`, 'u'))
  expect(failures, failures.join('\n')).toEqual([])
})
