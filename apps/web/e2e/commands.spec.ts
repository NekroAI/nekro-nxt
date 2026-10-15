import { expect, test } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  reserveJourneyPort,
  spawnJourneyServer,
  waitForJourneyServerReady,
  stopJourneyServer,
} from './fixtures/production-host.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { startCommandPlatform } from '../../server/tests/fixtures/command-platform.js'

test('production command journey: authorization, completion, denial, delivery failure and extension removal', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120000)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'nxt-command-journey-'))
  const port = await reserveJourneyPort()
  const origin = `http://127.0.0.1:${port}`
  const context = await browser.newContext({ baseURL: origin })
  const page = await context.newPage()
  const request = context.request
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const platform = await startCommandPlatform()
  const server = spawnJourneyServer(port, dataRoot)
  try {
    await waitForJourneyServerReady(origin, server)
    const connectionResponse = await request.post('/api/connections', {
      data: {
        adapterKey: 'onebot-11',
        alias: '命令旅程账号',
        configuration: { endpoint: platform.endpoint },
        credentials: {},
      },
    })
    expect(connectionResponse.ok()).toBe(true)
    const connection = HostApiContracts.createConnection.parseResponse(await connectionResponse.json())
    await expect.poll(platform.connected).toBe(true)
    platform.send('/status', true)
    let snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    await expect
      .poll(async () => {
        snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
        return snapshot.channels.some((channel) => channel.connectionId === connection.connectionId)
      })
      .toBe(true)
    const channel = snapshot.channels.find((c) => c.connectionId === connection.connectionId)!
    const forged = await request.post('/api/commands/execute', {
      data: { channelId: channel.id, text: '/off', requestId: 'forged', identity: { source: 'web' } },
    })
    expect(forged.status()).toBe(400)
    const missingRequestId = await request.post(`/api/channels/${channel.id}/messages`, {
      data: { parts: [{ type: 'text', text: '/off' }] },
    })
    expect(missingRequestId.status()).toBe(400)
    const settings = HostApiContracts.llmProviders.parseResponse(await (await request.get('/api/llm/providers')).json())
    const modelResponse = await request.post('/api/llm/providers/command-fixture', {
      data: {
        expectedRevision: settings.providers.find((p) => p.provider === 'command-fixture')?.settingsRevision ?? 0,
        displayName: '命令测试模型',
        baseURL: 'https://command-model.example.test/v1',
        api: 'openai-completions',
        apiKey: 'synthetic-command-fixture-key',
        models: [{ id: 'command-model', name: '命令测试模型' }],
      },
    })
    expect(modelResponse.ok(), await modelResponse.text()).toBe(true)
    const agentResponse = await request.post('/api/agents', {
      data: {
        displayName: '命令旅程智能体',
        persona: '',
        model: { provider: 'command-fixture', model: 'command-model' },
      },
    })
    expect(agentResponse.ok(), await agentResponse.text()).toBe(true)
    const agent = HostApiContracts.createAgent.parseResponse(await agentResponse.json())
    const binding = await request.post('/api/bindings', {
      data: { channelId: channel.id, agentId: agent.agentId, triggerPolicy: 'observe-only' },
    })
    expect(binding.ok()).toBe(true)
    await page.goto(`/channels/${channel.id}`)
    await expect(page.getByLabel('消息', { exact: true })).toBeVisible()
    await expect(page.getByLabel('命令记录').filter({ hasText: '智能体：未绑定' }).first()).toBeVisible()
    // Platform group administrator is still unauthorized until explicitly granted here.
    const beforeDenied = platform.sent.length
    // An unaddressed command in a group is ordinary chat, not a failed command.
    platform.send('/status')
    await page.waitForTimeout(300)
    expect(platform.sent).toHaveLength(beforeDenied)
    platform.send('/pause', true)
    await expect(page.getByText(/无权执行此命令/).first()).toBeVisible()
    // By default the member is told a grant is needed, instead of wondering whether the bot is broken.
    await expect.poll(() => platform.sent.length).toBe(beforeDenied + 1)
    expect(JSON.stringify(platform.sent.at(-1))).toContain('授予')
    // A name that is not a command here is ordinary chat for the agent, never a swallowed failure.
    platform.send('/不存在的命令', true)
    await expect(page.getByText('/不存在的命令').first()).toBeVisible()
    await expect(page.getByText(/未知命令：/)).toHaveCount(0)
    expect(platform.sent).toHaveLength(beforeDenied + 1)
    await page.screenshot({ path: testInfo.outputPath('unauthorized.png'), fullPage: true })
    const inspector = page.getByRole('button', { name: '频道信息' })
    if ((await inspector.count()) && (await inspector.getAttribute('aria-pressed')) !== 'true') await inspector.click()
    await expect(page.getByRole('switch', { name: '授权 示例成员' })).toBeVisible()
    await page.getByRole('switch', { name: '授权 示例成员' }).click()
    await expect(page.getByRole('switch', { name: '授权 示例成员' })).toBeChecked()
    // A previously saved weaker channel override must never look like the effective permission.
    expect(
      (
        await request.put('/api/commands/policy', {
          data: { scope: channel.id, name: 'status', policy: { permission: 'public' } },
        })
      ).ok(),
    ).toBe(true)
    expect(
      (
        await request.put('/api/commands/policy', {
          data: { scope: 'global', name: 'status', policy: { permission: 'channel-admin' } },
        })
      ).ok(),
    ).toBe(true)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'status 权限', exact: true })).toHaveText(
      /频道管理（全局设置要求）/u,
    )
    await expect(page.getByText(/此前保存的「普通用户」不生效/u)).toBeVisible()
    await page.getByRole('combobox', { name: 'status 权限', exact: true }).click()
    await expect(page.getByRole('option', { name: '普通用户', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('permission-floor.png'), fullPage: true })
    await page.keyboard.press('Escape')
    const bindingOf = async () => {
      const next = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
      return next.channels.find((c) => c.id === channel.id)?.bindings[0]
    }
    platform.send('/pause', true)
    await expect.poll(async () => (await bindingOf())?.paused).toBe(true)
    // Pausing never rewrites the response rule.
    expect((await bindingOf())?.triggerPolicy).toBe('observe-only')
    // A paused channel says so where people look, not only in the inspector.
    await page.goto(`/channels/${channel.id}`)
    await expect(page.getByRole('heading', { level: 1 }).getByText('已暂停', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('paused.png'), fullPage: true })
    platform.send('/resume', true)
    await expect.poll(async () => (await bindingOf())?.paused).toBe(false)
    await page.goto('/settings/commands')
    await expect(page.getByRole('heading', { name: '聊天命令', exact: true })).toBeVisible()
    // Help cannot be turned off, so it shows that instead of a disabled switch.
    await expect(page.getByRole('switch', { name: '启用 help' })).toHaveCount(0)
    await expect(page.getByRole('row', { name: /\/help/u }).getByText('始终开启')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true })
    const root = path.resolve(import.meta.dirname, '../../..')
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'apps/server/examples/command-echo/build.ts'], {
      cwd: root,
    })
    const archive = await readFile(path.join(root, '.local/command-echo.nxt-extension'))
    const inspectionResponse = await request.post('/api/extensions/imports/inspect', {
      data: archive,
      headers: { 'content-type': 'application/octet-stream', 'x-nekro-filename': 'command-echo.nxt-extension' },
    })
    expect(inspectionResponse.ok()).toBe(true)
    const inspected = HostApiContracts.inspectExtensionImport.parseResponse(await inspectionResponse.json())
    const importedResponse = await request.post(`/api/extensions/imports/${inspected.token}/commit`, { data: {} })
    expect(importedResponse.ok()).toBe(true)
    const imported = HostApiContracts.commitExtensionImport.parseResponse(await importedResponse.json())
    const activation = await request.post(
      `/api/agents/${agent.agentId}/extensions/${imported.extensionId}/activation`,
      { data: { revisionId: imported.revisionId } },
    )
    expect(activation.ok()).toBe(true)
    await page.goto(`/channels/${channel.id}`)
    const input = page.getByLabel('消息', { exact: true })
    const echoUsage = page.getByLabel('频道命令设置').locator('code').filter({ hasText: ':echo' })
    await expect(echoUsage).toBeVisible()
    const inspectorLayout = await echoUsage.evaluate((usage) => {
      const controls = usage.parentElement!
      const row = controls.parentElement!.parentElement!
      const description = row.firstElementChild!
      const section = row.closest('section[aria-label="频道命令设置"]')!
      return {
        descriptionWidth: description.getBoundingClientRect().width,
        stacked: description.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top,
        fits: section.scrollWidth <= section.clientWidth,
      }
    })
    expect(inspectorLayout.descriptionWidth).toBeGreaterThan(200)
    expect(inspectorLayout.stacked).toBe(true)
    expect(inspectorLayout.fits).toBe(true)
    await echoUsage.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('inspector-layout.png'), fullPage: true })
    await input.fill('/')
    const options = page.getByRole('option')
    await expect(options).toHaveCount(8)
    for (let i = 0; i < 7; i++) await input.press('ArrowDown')
    const selectedVisible = () =>
      page.getByRole('listbox', { name: '可用命令' }).evaluate((list) => {
        const option = list.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
        const viewport = list.getBoundingClientRect()
        return {
          visible: option.top >= viewport.top - 1 && option.bottom <= viewport.bottom + 1,
          scrollTop: list.scrollTop,
        }
      })
    await expect.poll(selectedVisible).toMatchObject({ visible: true })
    expect((await selectedVisible()).scrollTop).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('keyboard-completion.png'), fullPage: true })
    await input.press('ArrowDown')
    await expect.poll(selectedVisible).toMatchObject({ visible: true })
    await input.fill('/echo')
    await expect(page.getByRole('option', { name: /echo/ })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('suggestions.png'), fullPage: true })
    await input.press('Tab')
    await input.pressSequentially('"你好 世界" --count 2')
    const geometry = await input.boundingBox()
    expect(geometry?.width).toBeGreaterThan(180)
    await page.screenshot({ path: testInfo.outputPath('completion.png'), fullPage: true })
    const before = platform.sent.length
    await input.press('Enter')
    await expect(page.getByLabel('命令记录').filter({ hasText: '你好 世界\n你好 世界' }).first()).toBeVisible()
    const resultBody = page
      .getByLabel('命令记录')
      .filter({ hasText: '你好 世界\n你好 世界' })
      .first()
      .locator('[data-system-event-content]')
    await expect(resultBody).toHaveCSS('white-space', 'pre-wrap')
    expect(await resultBody.innerText()).toContain('你好 世界\n你好 世界')
    await expect(
      page.getByLabel('命令记录').filter({ hasText: '只在控制台显示，没有发送到频道' }).first(),
    ).toBeVisible()
    expect(JSON.stringify(platform.sent.slice(before))).not.toContain('/ext_COMMANDDEMO:echo')
    // Platform members always get their answer in the conversation, so delivery failures come from them.
    platform.failDelivery(true)
    platform.send('/status', true)
    await expect(page.getByText('执行成功，但回复投递失败或未确认。').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('delivery-failed.png'), fullPage: true })
    platform.failDelivery(false)
    const failedReply = page
      .getByLabel('命令记录')
      .filter({ has: page.getByRole('button', { name: '重发', exact: true }) })
    const replyId = await failedReply.getAttribute('data-message-id')
    const beforeRetry = platform.sent.length
    let reexecutions = 0
    page.on('request', (outgoing) => {
      if (outgoing.url().endsWith('/api/commands/execute')) reexecutions++
    })
    const retried = page.waitForResponse((response) => response.url().endsWith(`/api/outbound/${replyId}/resolve`))
    await failedReply.getByRole('button', { name: '重发', exact: true }).click()
    expect((await retried).ok()).toBe(true)
    await expect.poll(() => platform.sent.length).toBe(beforeRetry + 1)
    await expect(
      page.locator(`[data-message-id="${replyId}"]`).getByRole('button', { name: '重发', exact: true }),
    ).toHaveCount(0)
    expect(reexecutions).toBe(0)
    platform.unknownDelivery(true)
    platform.send('/status', true)
    const unknownReply = page
      .getByLabel('命令记录')
      .filter({ has: page.getByRole('button', { name: '已送达', exact: true }) })
    await expect(unknownReply).toBeVisible()
    const unknownId = await unknownReply.getAttribute('data-message-id')
    const beforeConfirm = platform.sent.length
    platform.unknownDelivery(false)
    const confirmed = page.waitForResponse((response) => response.url().endsWith(`/api/outbound/${unknownId}/resolve`))
    await unknownReply.getByRole('button', { name: '已送达', exact: true }).click()
    expect((await confirmed).ok()).toBe(true)
    await expect(
      page.locator(`[data-message-id="${unknownId}"]`).getByRole('button', { name: '重发', exact: true }),
    ).toHaveCount(0)
    expect(platform.sent).toHaveLength(beforeConfirm)
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.evaluate(() => localStorage.setItem('nekro-nxt.theme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await input.fill('/help')
    await expect(page.getByRole('option', { name: /help/ })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('dark-narrow.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.evaluate(() => localStorage.setItem('nekro-nxt.theme', 'light'))
    // Disable through the existing extension UI, then revisit the actual command catalog.
    await page.goto(`/workshop/extensions/${imported.extensionId}`)
    const disable = page
      .getByRole('row')
      .filter({ has: page.locator(`a[href="/agents/${agent.agentId}"]`) })
      .getByRole('switch')
    await expect(disable.first()).toBeVisible()
    const disabled = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/api/agents/${agent.agentId}/extensions/${imported.extensionId}/activation`),
    )
    await disable.first().click()
    expect((await disabled).ok()).toBe(true)
    await expect(disable.first()).not.toBeChecked()
    await page.goto(`/channels/${channel.id}`)
    await input.fill('/echo')
    await expect
      .poll(async () => {
        const catalog = HostApiContracts.listCommands.parseResponse(
          await (await request.get(`/api/commands?channelId=${channel.id}`)).json(),
        )
        return catalog.commands.some((command) => command.fullName.includes(':echo'))
      })
      .toBe(false)
    await expect(page.getByRole('option', { name: /echo/ })).toHaveCount(0)
    await input.fill('/echo 已停用')
    await input.press('Enter')
    await expect(page.getByText(/未知命令：\/echo/).first()).toBeVisible()
    await expect(page.locator('#root')).not.toBeEmpty()
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await platform.stop()
    await stopJourneyServer(server)
    await rm(dataRoot, { recursive: true, force: true })
  }
})
