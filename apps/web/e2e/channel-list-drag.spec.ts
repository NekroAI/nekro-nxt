import { expect, test, type Locator, type Page } from '@playwright/test'
import { installWorkspaceRoutes } from './fixtures/workspace.js'
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
const internalConnectionId = ConnectionIdSchema.parse('con_draginternal')

const dragTo = async (page: Page, source: Locator, target: Locator): Promise<void> => {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('拖拽目标没有几何尺寸。')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 6 })
  // Aim at the target's leading edge: sortable rows shift away from the pointer while they make room.
  const y = to.y + (to.y < from.y ? to.height * 0.25 : to.height * 0.75)
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(8, 8)
}

const beginDragTo = async (page: Page, source: Locator, target: Locator): Promise<{ x: number; y: number }> => {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('拖拽目标没有几何尺寸。')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 6 })
  const targetPoint = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 })
  return targetPoint
}

test('channel list keeps rows stable while pointer and keyboard drags reorder, bind, rebind and unbind', async ({
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
  const internalDescriptor = baseSnapshot.connectionAdapters.find(
    ({ provisioning, channelKinds }) => provisioning === 'system-singleton' && channelKinds.includes('internal'),
  )
  const internalConnection = baseSnapshot.connections.find(
    (connection) => connection.adapterKey === internalDescriptor?.key,
  )
  if (!internalConnection) throw new Error('测试快照缺少内置连接。')

  let snapshot: HostSnapshot = {
    ...baseSnapshot,
    connections: baseSnapshot.connections.map((connection) =>
      connection.id === internalConnection.id
        ? { ...connection, id: internalConnectionId, channelCount: 3 }
        : connection,
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
        appearance: {},
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
        appearance: {},
      },
    ],
    channels: [
      {
        id: mapleChannelId,
        connectionId: internalConnectionId,
        platformChannelId: 'internal-maple',
        kind: 'internal',
        displayName: '规划员的内置频道',
        boundAgentId: mapleId,
        runtimePhase: 'idle',
        activity: { unreadCount: 0, unreadCapped: false },
        bindings: [
          {
            channelId: mapleChannelId,
            agentId: mapleId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            activityTriggerOverrides: {},
            boundAt: 1,
          },
        ],
      },
      {
        id: mapleSpareChannelId,
        connectionId: internalConnectionId,
        platformChannelId: 'internal-maple-spare',
        kind: 'internal',
        displayName: '规划员的备用地',
        boundAgentId: mapleId,
        runtimePhase: 'idle',
        activity: { unreadCount: 0, unreadCapped: false },
        bindings: [
          {
            channelId: mapleSpareChannelId,
            agentId: mapleId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            activityTriggerOverrides: {},
            boundAt: 1,
          },
        ],
      },
      {
        id: clerkChannelId,
        connectionId: internalConnectionId,
        platformChannelId: 'internal-clerk',
        kind: 'internal',
        displayName: '资料员的内置频道',
        boundAgentId: clerkId,
        runtimePhase: 'idle',
        activity: { unreadCount: 0, unreadCapped: false },
        bindings: [
          {
            channelId: clerkChannelId,
            agentId: clerkId,
            triggerPolicy: 'always',
            processingFeedback: 'auto',
            activityTriggerOverrides: {},
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
        cursor: snapshot.cursor,
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
      body: JSON.stringify({ cursor: snapshot.cursor, messages: [], hasMore: false }),
    }),
  )
  await page.route('**/api/channels', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const input = HostApiContracts.createInternalChannel.request.parse(route.request().postDataJSON())
    snapshot = {
      ...snapshot,
      channels: [
        ...snapshot.channels,
        {
          id: extraChannelId,
          connectionId: internalConnectionId,
          platformChannelId: 'internal-extra',
          kind: 'internal',
          displayName: input.displayName,
          runtimePhase: 'idle',
          activity: { unreadCount: 0, unreadCapped: false },
          bindings: [],
        },
      ],
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ channelId: extraChannelId, connectionId: internalConnectionId }),
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
      activityTriggerOverrides: input.activityTriggerOverrides ?? {},
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

  await installWorkspaceRoutes(page, () => snapshot)

  await page.goto(`/channels/${mapleChannelId}`)
  const list = page.getByRole('complementary', { name: '频道', exact: true })
  // Rows are sortable buttons (dnd-kit) that also navigate; groups are headed by the agent.
  const row = (name: RegExp) => list.getByRole('button', { name })
  const mapleChannel = row(/规划员的内置频道/u)
  const mapleSpare = row(/规划员的备用地/u)
  const mapleHeader = list
    .getByRole('button', { name: /^规划员/u })
    .filter({ hasNot: page.locator('a') })
    .first()
  const clerkHeader = list.getByRole('button', { name: /^资料员\s*空闲/u })
  const unbound = list.getByText('未接线').first()
  const top = async (locator: Locator): Promise<number> => {
    const box = await locator.boundingBox()
    if (!box) throw new Error('排序目标没有几何尺寸。')
    return box.y
  }
  await expect(mapleChannel).toBeVisible()
  await expect(clerkHeader).toBeVisible()

  // Hover never reflows a row.
  const widthBeforeHover = (await mapleSpare.boundingBox())?.width ?? 0
  await mapleSpare.hover()
  expect(Math.abs(((await mapleSpare.boundingBox())?.width ?? 0) - widthBeforeHover)).toBeLessThanOrEqual(0.5)

  // A new web channel starts unbound.
  await list.getByRole('button', { name: '新建内置频道' }).click()
  const createDialog = page.getByRole('dialog')
  await createDialog.getByLabel('频道名称').fill('临时网页台')
  await createDialog.getByRole('button', { name: '创建' }).click()
  await expect(createDialog).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/channels/${extraChannelId}$`, 'u'))
  const extra = row(/临时网页台/u)
  await expect(extra).toBeVisible()
  expect(await top(extra)).toBeGreaterThan(await top(unbound))

  // A pointer jiggle past the drag threshold does not navigate.
  await page.goto(`/channels/${clerkChannelId}`)
  const routeBeforeDrag = page.url()
  const jiggle = await mapleChannel.boundingBox()
  if (!jiggle) throw new Error('频道行没有几何尺寸。')
  await page.mouse.move(jiggle.x + jiggle.width / 2, jiggle.y + jiggle.height / 2)
  await page.mouse.down()
  await page.mouse.move(jiggle.x + jiggle.width / 2 + 6, jiggle.y + jiggle.height / 2, { steps: 3 })
  await page.mouse.up()
  await expect(page).toHaveURL(routeBeforeDrag)

  // Live projection while dragging; Escape restores the original order.
  const spareTopBefore = await top(mapleSpare)
  await beginDragTo(page, mapleChannel, mapleSpare)
  await expect(page.locator('[class*="dragOverlay"]')).toHaveText('规划员的内置频道')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(async () => Math.abs((await top(mapleSpare)) - spareTopBefore)).toBeLessThan(2)
  await expect(page).toHaveURL(routeBeforeDrag)

  // Keyboard reorder: Space picks up, Arrow moves, Space drops.
  expect(await top(mapleChannel)).toBeLessThan(await top(mapleSpare))
  await mapleChannel.focus()
  await page.keyboard.press('Space')
  await expect(mapleChannel).toHaveAttribute('aria-pressed', 'true')
  const announcer = page.locator('[id^="DndLiveRegion"]')
  await page.keyboard.press('ArrowDown')
  await expect(announcer).toContainText('移到频道「规划员的备用地」')
  await expect(announcer).not.toContainText('chn_')
  await page.keyboard.press('Space')
  await expect.poll(async () => (await top(mapleSpare)) < (await top(mapleChannel))).toBe(true)

  await expect.poll(() => snapshot.workTreeOrder.channelIdsByAgent[mapleId]?.[0]).toBe(mapleSpareChannelId)

  // A rejected order explains itself and keeps the saved order.
  const savedChannelTop = await top(mapleChannel)
  rejectNextOrder = true
  allowOrderFailureConsole = true
  await dragTo(page, mapleChannel, mapleSpare)
  await expect.poll(() => rejectedOrderRequests).toBe(1)
  await expect(page.getByText('测试拒绝保存顺序。')).toBeVisible()
  await expect.poll(async () => Math.abs((await top(mapleChannel)) - savedChannelTop)).toBeLessThan(2)
  allowOrderFailureConsole = false

  // Pointer reorder within a group and of whole groups never asks for confirmation.
  await dragTo(page, mapleChannel, mapleSpare)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await top(mapleChannel)) < (await top(mapleSpare))).toBe(true)
  expect(await top(mapleHeader)).toBeLessThan(await top(clerkHeader))
  await dragTo(page, mapleHeader, clerkHeader)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await top(clerkHeader)) < (await top(mapleHeader))).toBe(true)

  // Crossing groups binds, rebinds or unbinds, each after an explicit confirmation.
  await dragTo(page, extra, clerkHeader)
  const bindDialog = page.getByRole('dialog')
  await expect(bindDialog.getByRole('heading', { name: '让资料员响应「临时网页台」' })).toBeVisible()
  await bindDialog.getByRole('button', { name: '接线' }).click()
  await expect(bindDialog).toHaveCount(0)
  await expect
    .poll(() => snapshot.channels.find((channel) => channel.id === extraChannelId)?.boundAgentId)
    .toBe(clerkId)

  await dragTo(page, mapleChannel, clerkHeader)
  const rebindDialog = page.getByRole('dialog')
  await expect(rebindDialog.getByRole('heading', { name: '让资料员响应「规划员的内置频道」' })).toBeVisible()
  await rebindDialog.getByRole('button', { name: '换绑' }).click()
  await expect(rebindDialog).toHaveCount(0)
  await expect
    .poll(() => snapshot.channels.find((channel) => channel.id === mapleChannelId)?.boundAgentId)
    .toBe(clerkId)

  await dragTo(page, row(/资料员的内置频道/u), unbound)
  const unbindDialog = page.getByRole('dialog')
  await expect(unbindDialog.getByRole('heading', { name: /断开「资料员的内置频道」/u })).toBeVisible()
  await unbindDialog.getByRole('button', { name: '断开' }).click()
  await expect(unbindDialog).toHaveCount(0)
  await expect.poll(() => snapshot.channels.find((channel) => channel.id === clerkChannelId)?.bindings.length).toBe(0)

  const screenshot = testInfo.outputPath('channel-list-after-drags.png')
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('channel-list-after-drags', { path: screenshot, contentType: 'image/png' })
  expect(failures, failures.join('\n')).toEqual([])
})
