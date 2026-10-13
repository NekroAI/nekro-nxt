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
    platform.send('/off')
    await expect(page.getByText(/无权执行此命令/).first()).toBeVisible()
    expect(platform.sent).toHaveLength(beforeDenied)
    platform.send('/不存在的命令')
    await expect(page.getByText(/未知命令：\/不存在的命令/).first()).toBeVisible()
    expect(platform.sent).toHaveLength(beforeDenied)
    await page.screenshot({ path: testInfo.outputPath('unauthorized.png'), fullPage: true })
    const inspector = page.getByRole('button', { name: '频道信息' })
    if ((await inspector.count()) && (await inspector.getAttribute('aria-pressed')) !== 'true') await inspector.click()
    await expect(page.getByRole('switch', { name: '授权 示例成员' })).toBeVisible()
    await page.getByRole('switch', { name: '授权 示例成员' }).click()
    await expect(page.getByRole('switch', { name: '授权 示例成员' })).toBeChecked()
    platform.send('/on')
    await expect
      .poll(async () => {
        const next = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
        return next.channels.find((c) => c.id === channel.id)?.bindings[0]?.triggerPolicy
      })
      .toBe('mentioned-or-replied')
    await page.goto('/settings/commands')
    await expect(page.getByRole('heading', { name: '命令', exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用 help' })).toBeDisabled()
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
    expect(JSON.stringify(platform.sent.slice(before))).not.toContain('/ext_COMMANDDEMO:echo')
    platform.failDelivery(true)
    await input.fill('/status ')
    await input.press('Enter')
    await expect(page.getByText('执行成功，但回复投递失败或未确认。').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('delivery-failed.png'), fullPage: true })
    platform.failDelivery(false)
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
    await disable.first().click()
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
