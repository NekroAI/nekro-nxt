import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  HostApiContracts,
} from '@nekro-nxt/contracts'

type HostSnapshot = ReturnType<typeof HostApiContracts.snapshot.response.parse>

const mapleId = AgentIdSchema.parse('agt_dragmaple')
const clerkId = AgentIdSchema.parse('agt_dragclerk')
const mapleChannelId = ChannelIdSchema.parse('chn_dragmaple')
const mapleSpareChannelId = ChannelIdSchema.parse('chn_dragmaplespare')
const clerkChannelId = ChannelIdSchema.parse('chn_dragclerk')
const extraChannelId = ChannelIdSchema.parse('chn_dragextra')
const webConnectionId = ConnectionIdSchema.parse('con_dragweb')

const dragTo = async (page: Page, source: Locator, target: Locator): Promise<void> => {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('拖拽目标没有几何尺寸。')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 6 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(8, 8)
}

test('work tree keeps titles stable while full rows and keyboard handles cover ordering and binding', async ({
  page,
  request,
}, testInfo) => {
  const failures: string[] = []
  let allowOrderFailureConsole = false
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !(allowOrderFailureConsole && message.text().includes('409'))) {
      failures.push(`console.error: ${message.text()}`)
    }
  })

  const baseResponse = await request.get('/api/snapshot')
  expect(baseResponse.ok()).toBe(true)
  const baseSnapshot = HostApiContracts.snapshot.response.parse(await baseResponse.json())
  const webConnection = baseSnapshot.connections.find((connection) => connection.adapterKey === 'web')
  if (!webConnection) throw new Error('测试快照缺少网页连接。')

  let snapshot: HostSnapshot = {
    ...baseSnapshot,
    connections: baseSnapshot.connections.map((connection) =>
      connection.id === webConnection.id ? { ...connection, id: webConnectionId, channelCount: 3 } : connection,
    ),
    agents: [
      {
        id: mapleId,
        displayName: '规划员',
        persona: '',
        personaDocument: { version: 1, segments: [] },
        currentRevisionId: AgentRevisionIdSchema.parse('arev_dragmaple'),
        createdAt: 1,
        runtimeStatus: 'idle',
        runtimePhase: 'idle',
        model: { provider: 'openai', model: 'gpt-5' },
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
        channels: [mapleChannelId, mapleSpareChannelId],
      },
      {
        id: clerkId,
        displayName: '资料员',
        persona: '',
        personaDocument: { version: 1, segments: [] },
        currentRevisionId: AgentRevisionIdSchema.parse('arev_dragclerk'),
        createdAt: 2,
        runtimeStatus: 'idle',
        runtimePhase: 'idle',
        model: { provider: 'openai', model: 'gpt-5' },
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
        channels: [clerkChannelId],
      },
    ],
    channels: [
      {
        id: mapleChannelId,
        connectionId: webConnectionId,
        platformChannelId: 'web-maple',
        kind: 'web',
        displayName: '规划员的内置频道',
        boundAgentId: mapleId,
        runtimePhase: 'idle',
        bindings: [
          {
            channelId: mapleChannelId,
            agentId: mapleId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            eventTriggers: [],
            boundAt: 1,
          },
        ],
      },
      {
        id: mapleSpareChannelId,
        connectionId: webConnectionId,
        platformChannelId: 'web-maple-spare',
        kind: 'web',
        displayName: '规划员的备用地',
        boundAgentId: mapleId,
        runtimePhase: 'idle',
        bindings: [
          {
            channelId: mapleSpareChannelId,
            agentId: mapleId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            eventTriggers: [],
            boundAt: 1,
          },
        ],
      },
      {
        id: clerkChannelId,
        connectionId: webConnectionId,
        platformChannelId: 'web-clerk',
        kind: 'web',
        displayName: '资料员的内置频道',
        boundAgentId: clerkId,
        runtimePhase: 'idle',
        bindings: [
          {
            channelId: clerkChannelId,
            agentId: clerkId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            eventTriggers: [],
            boundAt: 2,
          },
        ],
      },
    ],
  }

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
  await page.route('**/api/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
      }),
    })
  })
  await page.route('**/api/channels/*/messages?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], hasMore: false }),
    }),
  )
  await page.route('**/api/channels', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const input = HostApiContracts.createWebChannel.request.parse(route.request().postDataJSON())
    snapshot = {
      ...snapshot,
      channels: [
        ...snapshot.channels,
        {
          id: extraChannelId,
          connectionId: webConnectionId,
          platformChannelId: 'web-extra',
          kind: 'web',
          displayName: input.displayName,
          runtimePhase: 'idle',
          bindings: [],
        },
      ],
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ channelId: extraChannelId, connectionId: webConnectionId }),
    })
  })
  await page.route('**/api/bindings', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const input = HostApiContracts.createBinding.request.parse(route.request().postDataJSON())
    const binding = {
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: input.triggerPolicy,
      processingFeedback: input.processingFeedback ?? 'auto',
      eventTriggers: input.eventTriggers ?? [],
      boundAt: 3,
    }
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) =>
        agent.id === input.agentId && !agent.channels.includes(input.channelId)
          ? { ...agent, channels: [...agent.channels, input.channelId] }
          : agent.id !== input.agentId
            ? { ...agent, channels: agent.channels.filter((id) => id !== input.channelId) }
            : agent,
      ),
      channels: snapshot.channels.map((channel) =>
        channel.id === input.channelId ? { ...channel, boundAgentId: input.agentId, bindings: [binding] } : channel,
      ),
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(binding) })
  })
  await page.route('**/api/bindings/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => ({
        ...agent,
        channels: agent.channels.filter((id) => id !== channelId),
      })),
      channels: snapshot.channels.map((channel) =>
        channel.id === channelId ? { ...channel, bindings: [], runtimePhase: 'idle' } : channel,
      ),
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channelId, cleared: true }),
    })
  })
  let rejectNextOrder = false
  let rejectedOrderRequests = 0
  await page.route('**/api/work-tree-order', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    if (rejectNextOrder) {
      rejectNextOrder = false
      rejectedOrderRequests += 1
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'order-conflict', message: '测试拒绝保存顺序。' } }),
      })
    }
    const order = HostApiContracts.putWorkTreeOrder.request.parse(route.request().postDataJSON())
    snapshot = { ...snapshot, workTreeOrder: order }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) })
  })

  await page.goto('/work')
  await expect(page.getByRole('link', { name: /规划员/u }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()

  const mapleChannel = page.getByRole('link', { name: /规划员的内置频道/u })
  const mapleSpare = page.getByRole('link', { name: /规划员的备用地/u })
  const mapleHeader = page.getByRole('link', { name: /规划员.*\d+ 个频道/u })
  const clerkHeader = page.getByRole('link', { name: /资料员.*\d+ 个频道/u })
  const mapleChannelHandle = page.getByRole('button', { name: '拖动“规划员的内置频道”排序' })
  const top = async (locator: Locator): Promise<number> => {
    const box = await locator.boundingBox()
    if (!box) throw new Error('排序目标没有几何尺寸。')
    return box.y
  }

  const widthBeforeHover = (await mapleChannel.boundingBox())?.width
  await mapleChannel.hover()
  const widthAfterHover = (await mapleChannel.boundingBox())?.width
  expect(widthBeforeHover).toBeDefined()
  expect(widthAfterHover).toBeDefined()
  expect(Math.abs((widthAfterHover ?? 0) - (widthBeforeHover ?? 0))).toBeLessThanOrEqual(0.5)
  const objectPane = page.getByLabel('对象列')
  await expect(objectPane.getByRole('button', { name: /频道操作/u })).toHaveCount(0)
  await expect(objectPane.getByRole('button', { name: /智能体操作/u })).toHaveCount(0)

  await page.getByRole('button', { name: '新建内置频道' }).click()
  const createDialog = page.getByRole('dialog')
  await expect(createDialog.getByRole('heading', { name: '新建内置频道' })).toBeVisible()
  await createDialog.getByLabel('频道名称').fill('临时网页台')
  await createDialog.getByRole('button', { name: '创建内置频道' }).click()
  await expect(page.getByRole('link', { name: /临时网页台/u })).toBeVisible()

  expect(await top(mapleChannel)).toBeLessThan(await top(mapleSpare))
  await mapleChannelHandle.focus()
  await page.keyboard.press('Space')
  await expect(mapleChannelHandle).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('channel:chn_dragmaplespare')
  await page.keyboard.press('Space')
  await expect(mapleChannelHandle).not.toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await top(mapleSpare)) < (await top(mapleChannel))).toBe(true)

  const rejectedChannelTop = await top(mapleChannel)
  const rejectedSpareTop = await top(mapleSpare)
  rejectNextOrder = true
  allowOrderFailureConsole = true
  await dragTo(page, mapleChannel, mapleSpare)
  await expect.poll(() => rejectedOrderRequests).toBe(1)
  await expect(page.getByText('测试拒绝保存顺序。')).toBeVisible()
  await expect.poll(async () => Math.abs((await top(mapleChannel)) - rejectedChannelTop) < 1).toBe(true)
  await expect.poll(async () => Math.abs((await top(mapleSpare)) - rejectedSpareTop) < 1).toBe(true)
  allowOrderFailureConsole = false

  await dragTo(page, mapleChannel, mapleSpare)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await top(mapleChannel)) < (await top(mapleSpare))).toBe(true)
  await dragTo(page, mapleSpare, mapleChannel)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await top(mapleSpare)).toBeLessThan(await top(mapleChannel))
  expect(await top(mapleHeader)).toBeLessThan(await top(clerkHeader))
  await dragTo(page, mapleHeader, clerkHeader)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await top(clerkHeader)) < (await top(mapleHeader))).toBe(true)

  await dragTo(
    page,
    page.getByRole('link', { name: /临时网页台/u }),
    page.getByRole('link', { name: /资料员.*\d+ 个频道/u }),
  )
  const bindDialog = page.getByRole('dialog')
  await expect(bindDialog.getByRole('heading', { name: '交给智能体响应' })).toBeVisible()
  await expect(bindDialog.getByText(/将「临时网页台」交给「资料员」响应/u)).toBeVisible()
  await bindDialog.getByRole('button', { name: '交给该智能体响应' }).click()
  await expect(bindDialog).toHaveCount(0)

  await dragTo(page, mapleChannel, clerkHeader)
  const rebindDialog = page.getByRole('dialog')
  await expect(rebindDialog.getByRole('heading', { name: '改由其他智能体响应' })).toBeVisible()
  await expect(rebindDialog.getByText(/将「规划员的内置频道」改由「资料员」响应/u)).toBeVisible()
  await rebindDialog.getByRole('button', { name: '改由该智能体响应' }).click()
  await expect(rebindDialog).toHaveCount(0)
  await expect(mapleChannelHandle).toBeFocused()

  const clerkChannelHandle = page.getByRole('button', { name: '拖动“资料员的内置频道”排序' })
  await dragTo(
    page,
    page.getByRole('link', { name: /资料员的内置频道/u }),
    page.getByText('未绑定频道', { exact: true }),
  )
  const unbindDialog = page.getByRole('dialog')
  await expect(unbindDialog.getByRole('heading', { name: '解除频道绑定' })).toBeVisible()
  await expect(unbindDialog.getByText(/先停止「资料员」在「资料员的内置频道」中的当前工作/u)).toBeVisible()
  await unbindDialog.getByRole('button', { name: '停止并解除绑定' }).click()
  await expect(unbindDialog).toHaveCount(0)
  await expect(clerkChannelHandle).toBeFocused()

  const closeNotifications = page.getByRole('button', { name: '关闭通知' }).filter({ visible: true })
  for (let attempt = 0; attempt < 8 && (await closeNotifications.count()) > 0; attempt += 1) {
    const closeNotification = closeNotifications.first()
    await closeNotification.click()
    await expect(closeNotification).toBeHidden()
  }
  await page.getByRole('link', { name: /临时网页台/u }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('link', { name: /临时网页台/u }).hover()
  const screenshot = testInfo.outputPath('work-tree-hover-drag-handle.png')
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('work-tree-hover-drag-handle', { path: screenshot, contentType: 'image/png' })

  expect(failures, failures.join('\n')).toEqual([])
})
