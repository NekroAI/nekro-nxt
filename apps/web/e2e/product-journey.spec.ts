import { expect, test, type Page } from '@playwright/test'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  HostApiContracts,
} from '@nekro-nxt/contracts'

type HostSnapshot = ReturnType<typeof HostApiContracts.snapshot.response.parse>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const installDeepSeekProviderRoutes = async (page: Page, initiallySaved = false): Promise<void> => {
  let saved = initiallySaved
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
    if (!isRecord(payload) || typeof payload['expectedRevision'] !== 'number') {
      throw new TypeError('模型供应商保存请求缺少 expectedRevision。')
    }
    saved = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseBody()) })
  })
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
  await expect(page.getByText(/不会.*回显/u)).toBeVisible()

  await page.getByRole('link', { name: '工作' }).click()
  await expect(page.getByRole('link', { name: '工作' })).toBeVisible()
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '模型供应商', level: 1 })).toBeVisible()

  expect(failures, failures.join('\n')).toEqual([])
})

test('DSH extension settings load the official native surface and generic fallback from the production bundle', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  await page.goto('/settings?tab=dsh-extensions')

  await expect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
  await expect(page.locator('[data-dsh-native-surface]')).toBeVisible()
  await expect(page.locator('[data-dsh-native-surface]')).toContainText(/Web search|网页搜索/u)
  await page.getByRole('tab', { name: '通用配置' }).click()
  await expect(page.getByText('Namespace：web-search-deepseek', { exact: true })).toBeVisible()
  await expect(page.getByLabel('新的凭据值')).toHaveAttribute('type', 'password')

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
    .getByRole('link', { name: /网页聊天/u })
    .first()
    .click()
  await expect(page.getByText('网页聊天由当前设备管理，不需要配置账号凭据。')).toBeVisible()
  await expect(page.getByLabel('Client Secret')).toHaveCount(0)

  await page.getByRole('link', { name: '添加平台连接' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '选择平台' })).toBeVisible()
  await expect(dialog.getByText('选择要连接的平台账号。')).toBeVisible()
  await dialog.getByLabel('平台').click()
  await expect(page.getByRole('option', { name: 'QQ 官方机器人' })).toBeVisible()
  await page.getByRole('option', { name: 'QQ 官方机器人' }).click()
  await expect(dialog.getByLabel('App ID')).toHaveCount(0)

  await dialog.getByRole('button', { name: '继续配置' }).click()
  await expect(dialog.getByRole('heading', { name: '配置 QQ 官方机器人' })).toBeVisible()
  await expect(dialog.getByLabel('连接别名')).toBeVisible()
  await dialog.getByLabel('连接别名').fill('旅程测试连接')
  await expect(dialog.getByLabel('App ID')).toBeVisible()
  await expect(dialog.getByLabel('Client Secret')).toHaveAttribute('type', 'password')
  await expect(dialog.getByText('使用 Markdown')).toBeVisible()
  await expect(dialog.getByLabel('平台')).toHaveCount(0)
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
      currentRevisionId: plan.revisionId,
      createdAt: 1_725_000_000_000 + created * 100,
      runtimeStatus: 'idle',
      runtimePhase: 'idle',
      model: input.model,
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
      displayName: `${plan.displayName} 的网页频道`,
      boundAgentId: plan.agentId,
      runtimePhase: 'idle',
      bindings: [
        {
          channelId: plan.channelId,
          agentId: plan.agentId,
          triggerPolicy: 'always',
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
  await page.getByRole('option', { name: `网页聊天 · ${sourceName} 的网页频道`, exact: true }).click()
  await dialog.getByLabel('响应方式').click()
  await page.getByRole('option', { name: '仅观察' }).click()
  await dialog.getByRole('button', { name: '绑定频道' }).click()

  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await expect(page.getByText(`${sourceName} 的网页频道`, { exact: true }).first()).toBeVisible()
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
      currentRevisionId: AgentRevisionIdSchema.parse('arev_journeybind'),
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
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
  await dialog.getByRole('button', { name: '绑定频道' }).click()
  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await expect(page).toHaveURL(/\/connections(?:\/|$)/u)
  await expect(page.getByRole('heading', { name: 'QQ 官方机器人' })).toBeVisible()
  expect(failures, failures.join('\n')).toEqual([])
})
