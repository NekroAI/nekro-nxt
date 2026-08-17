import { expect, test, type Page, type TestInfo } from '@playwright/test'

const productSnapshot = {
  connectionAdapters: [
    {
      key: 'web',
      displayName: '网页聊天',
      description: '网页聊天',
      userCreatable: false,
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'qq-openclaw',
      displayName: 'QQ 官方机器人',
      description: '连接 QQ 机器人账号',
      userCreatable: true,
      configSchema: {
        schemaVersion: 1,
        type: 'object',
        required: ['appId', 'clientSecret'],
        properties: {
          appId: { type: 'string', title: 'App ID' },
          clientSecret: { type: 'credential-reference', title: 'Client Secret' },
          markdown: { type: 'boolean', title: '使用 Markdown', description: '允许发送 Markdown 消息。', default: true },
        },
      },
    },
  ],
  models: [{ provider: 'deepseek', providerName: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
  agents: [
    {
      id: 'agent-target-internal-id',
      displayName: '资料员',
      persona: '严谨、简洁',
      currentRevisionId: 'revision-target-internal-id',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
      channels: ['channel-target'],
    },
    {
      id: 'agent-source-internal-id',
      displayName: '记录员',
      persona: '',
      currentRevisionId: 'revision-source-internal-id',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
      channels: ['channel-source'],
    },
  ],
  channels: [
    {
      id: 'channel-target',
      connectionId: 'connection-web',
      platformChannelId: 'platform-target',
      kind: 'web',
      displayName: '资料员的网页频道',
      boundAgentId: 'agent-target-internal-id',
      bindings: [{ id: 'binding-target', agentId: 'agent-target-internal-id', triggerPolicy: 'always' }],
    },
    {
      id: 'channel-source',
      connectionId: 'connection-web',
      platformChannelId: 'platform-source',
      kind: 'web',
      displayName: '记录员的网页频道',
      boundAgentId: 'agent-source-internal-id',
      bindings: [{ id: 'binding-source', agentId: 'agent-source-internal-id', triggerPolicy: 'always' }],
    },
  ],
  messages: [
    {
      id: 'message-visible',
      channelId: 'channel-target',
      role: 'member',
      parts: [{ type: 'text', text: '请复核今天的记录。' }],
      occurredAt: 1_725_000_000_000,
    },
  ],
  connections: [
    {
      id: 'connection-web',
      adapterKey: 'web',
      status: 'active',
      credentialConfigured: true,
      channelCount: 2,
      knownChannels: [],
    },
  ],
  extensions: [],
  dynamic: [],
} as const

const installRuntimeFailureGate = (page: Page): string[] => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

const installProductRoutes = async (page: Page): Promise<void> => {
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(productSnapshot) }),
  )
}

const assertViewportIntegrity = async (page: Page): Promise<void> => {
  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector('aside')?.getBoundingClientRect()
    const main = document.querySelector('main')?.getBoundingClientRect()
    const routeContent = document.querySelector('main > div > div')?.getBoundingClientRect()
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      routeContentHeight: routeContent?.height ?? 0,
      overlaps: sidebar && main ? sidebar.right > main.left + 1 : false,
    }
  })
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.routeContentHeight).toBeGreaterThanOrEqual(geometry.viewportHeight - 1)
  expect(geometry.overlaps).toBe(false)
}

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('three desktop viewports remain usable in both themes and reduced motion', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)

  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto('/channels/channel-target')
      await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
      await expect(page.getByText('请复核今天的记录。')).toBeVisible()
      await expect(page.getByLabel('消息内容')).toBeVisible()
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `channel-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('an initial Host failure is explicit and can recover without reloading', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  let healthy = false
  await page.route('**/api/snapshot', (route) => {
    if (!healthy) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '测试服务暂不可用' } }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(productSnapshot) })
  })
  await page.goto('/agents')
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('还没有智能体', { exact: true })).toBeVisible()
  healthy = true
  await page.getByRole('button', { name: '重新连接' }).last().click()
  await expect(page.getByText('运行正常', { exact: true })).toBeVisible()
  await expect(page.getByText('资料员', { exact: true })).toBeVisible()
  expect(
    failures.filter((failure) => !failure.includes('503 (Service Unavailable)')),
    failures.join('\n'),
  ).toEqual([])
})

test('dialog floating layers, Escape, focus return, and pending failure recovery work together', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/connections')

  const opener = page.getByRole('button', { name: '添加连接' }).first()
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('平台').click()
  const floating = page.locator('[data-nxt-floating-layer]').last()
  await expect(floating).toBeVisible()
  const layers = await page.evaluate(() => {
    const dialogElement = document.querySelector('[role="dialog"]')
    const floatingElement = document.querySelector('[data-nxt-floating-layer]')
    return {
      dialog: Number(dialogElement ? getComputedStyle(dialogElement).zIndex : 0),
      floating: Number(floatingElement ? getComputedStyle(floatingElement).zIndex : 0),
    }
  })
  expect(layers.floating).toBeGreaterThan(layers.dialog)
  await capture(page, testInfo, 'connection-platform-select-layer')
  await page.keyboard.press('Escape')
  await expect(floating).toBeHidden()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()

  await page.goto('/agents/agent-target-internal-id')
  await page.getByRole('tab', { name: '频道' }).click()
  await page.getByRole('button', { name: '绑定频道' }).click()
  const bindingDialog = page.getByRole('dialog')
  let attempts = 0
  await page.route('**/api/bindings', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '测试写入失败' } }),
      })
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
  })

  const confirm = bindingDialog.getByRole('button', { name: '绑定频道' })
  await confirm.click()
  await expect(bindingDialog.getByRole('button', { name: '处理中…' })).toBeDisabled()
  await expect(bindingDialog.getByText('测试写入失败')).toBeVisible()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(bindingDialog).toBeHidden()
  await expect(page.getByText('频道已绑定。')).toBeVisible()
  expect(attempts).toBe(2)
  expect(
    failures.filter((failure) => !failure.includes('500 (Internal Server Error)')),
    failures.join('\n'),
  ).toEqual([])
})
