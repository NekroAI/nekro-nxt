import { expect, test, type Page } from '@playwright/test'
import { HostApiContracts, type HostApiResponse, type RuntimeCompatibilityDiagnostic } from '@nekro-nxt/contracts'
import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import {
  productSnapshot,
  targetAgentId,
  targetChannelId,
  summaryExtensionId,
  summaryRevisionId,
} from './fixtures/product-quality.js'

type Snapshot = HostApiResponse<'snapshot'>
const issue = (
  objectKind: RuntimeCompatibilityDiagnostic['objectKind'],
  objectId: string,
  reason: string,
): RuntimeCompatibilityDiagnostic => ({
  objectKind,
  objectId,
  objectVersion: objectKind === 'extension' ? summaryRevisionId : 'synthetic-config-v1',
  configurationRevision: JSON.stringify([targetAgentId, {}]),
  runtimeFingerprint: 'synthetic-runtime-v2',
  status: 'isolated',
  phase: 'restore',
  reason,
  retryable: true,
  checkedAt: 1_725_000_000_000,
})

async function installUpgradeHost(page: Page, diagnostics: RuntimeCompatibilityDiagnostic[] = []) {
  let snapshot = HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    agents: productSnapshot.agents.map((agent) => ({ ...agent, runtimeStatus: 'idle', runtimePhase: 'idle' })),
    extensions: productSnapshot.extensions
      .filter((extension) => extension.id === summaryExtensionId)
      .map((extension) => ({ ...extension, activations: [] })),
    hostUi: { preferencesRevision: 0, pages: [] },
    dynamic: [],
    authoringTasks: [],
    upgrade: {
      runtimeVersion: DSH_RUNTIME_RELEASE.dshVersion,
      sessionCompatibilityId: DSH_RUNTIME_RELEASE.sessionCompatibilityId,
      resetContexts: true,
      diagnostics,
    },
  })
  let healthRelease = snapshot.productMetadata!.releaseId
  let snapshots = 0
  let retryError: string | undefined
  const retries: unknown[] = []
  const messages: unknown[] = []
  const unexpected: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await installSnapshotHealthRoutes(page, () => ({
    productMetadata: { ...snapshot.productMetadata!, releaseId: healthRelease },
  }))
  await page.route('**/api/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (value: unknown) => route.fulfill({ json: value })
    if (url.pathname === '/api/events') return // Keep the synthetic stream open without reconnecting forever.
    if (url.pathname === '/api/snapshot') {
      snapshots += 1
      return json(snapshot)
    }
    if (url.pathname === '/api/runtime/compatibility/retry') {
      const input = HostApiContracts.retryRuntimeCompatibility.parseRequest(request.postDataJSON())
      retries.push(input)
      if (retryError)
        return route.fulfill({ status: 400, json: { error: { code: 'retry-failed', message: retryError } } })
      snapshot = HostApiContracts.snapshot.parseResponse({
        ...snapshot,
        upgrade: {
          ...snapshot.upgrade,
          diagnostics: snapshot.upgrade!.diagnostics.filter(
            (item) => item.objectKind !== input.objectKind || item.objectId !== input.objectId,
          ),
        },
      })
      return json(
        HostApiContracts.retryRuntimeCompatibility.parseResponse({ diagnostics: snapshot.upgrade!.diagnostics }),
      )
    }
    if (url.pathname === '/api/llm/providers')
      return json(HostApiContracts.llmProviders.parseResponse({ writable: true, protocols: [], providers: [] }))
    if (url.pathname === '/api/dsh/plugins') return json({ plugins: [] })
    if (url.pathname === '/api/dsh/settings') return json({ namespaces: [] })
    if (url.pathname.endsWith('/inventory')) return json({ rows: [] })
    if (url.pathname.endsWith('/runtime')) {
      const channelId = url.pathname.split('/')[3]
      return json({
        cursor: snapshot.cursor,
        channelId,
        agentId: targetAgentId,
        phase: 'idle',
        pendingInjectCount: 0,
        turns: [],
      })
    }
    if (url.pathname.endsWith('/messages') && request.method() === 'GET')
      return json({ cursor: snapshot.cursor, messages: [], hasMore: false })
    if (url.pathname === `/api/channels/${targetChannelId}/messages` && request.method() === 'POST') {
      messages.push(request.postDataJSON())
      return json({ inserted: true })
    }
    if (url.pathname === '/api/platform-users')
      return json({ total: 0, items: [], facets: { adapters: [], connections: [] } })
    unexpected.push(`${request.method()} ${url.pathname}`)
    return route.fulfill({
      status: 404,
      json: { error: { code: 'unexpected-fixture-request', message: '此合成宿主没有该接口。' } },
    })
  })
  return {
    retries,
    messages,
    unexpected,
    pageErrors,
    snapshots: () => snapshots,
    snapshot: (): Snapshot => snapshot,
    changeRelease: (releaseId: string) => {
      healthRelease = releaseId
    },
    failRetry: (message: string) => {
      retryError = message
    },
  }
}

test('upgrade summary keeps reset context visible and retries an isolated extension through its owner', async ({
  page,
}, testInfo) => {
  const fixture = await installUpgradeHost(page, [
    issue('extension', summaryExtensionId, '合成扩展需要重新检查加载兼容性。'),
    issue('model-provider', 'deepseek', '合成模型配置需要重新检查。'),
  ])
  await page.goto(`/work/agents/${targetAgentId}`)
  const agentNotice = page.locator('[data-upgrade-notice]')
  await expect(agentNotice).toContainText('旧上下文已归档，聊天记录已保留')
  await expect(agentNotice).toContainText('合成扩展需要重新检查加载兼容性。')
  await expect(agentNotice).toContainText('合成模型配置需要重新检查。')
  await page.goto(`/extensions/${summaryExtensionId}`)
  const notice = page.locator('[data-upgrade-notice]')
  await expect(notice).toContainText('群聊摘要已暂停')
  await expect(notice).not.toContainText('合成模型配置需要重新检查。')
  const before = fixture.snapshots()
  await notice.getByRole('button', { name: '重新检查兼容性' }).click()
  await expect.poll(() => fixture.retries).toEqual([{ objectKind: 'extension', objectId: summaryExtensionId }])
  await expect.poll(fixture.snapshots).toBeGreaterThan(before)
  await expect(page.locator('[data-upgrade-notice]')).toHaveCount(0)
  await page.goto('/settings?tab=about')
  await expect(page.locator('[data-upgrade-notice]')).toContainText('旧上下文已归档，聊天记录已保留')
  await expect(page.locator('[data-upgrade-notice]')).toContainText('合成模型配置需要重新检查。')
  await testInfo.attach('upgrade-summary', { body: await page.screenshot(), contentType: 'image/png' })
  expect(fixture.pageErrors).toEqual([])
  expect(fixture.unexpected).toEqual([])
})

test('failed provider retry keeps the saved model and the isolation reason visible', async ({ page }) => {
  const fixture = await installUpgradeHost(page, [issue('model-provider', 'deepseek', '合成供应商配置尚不兼容。')])
  const originalModel = fixture.snapshot().agents.find((agent) => agent.id === targetAgentId)!.model
  fixture.failRetry('当前保存的配置仍不兼容，请修复后重试。')
  await page.goto('/settings?tab=about')
  const notice = page.locator('[data-upgrade-notice]')
  await notice.getByRole('button', { name: '重新检查兼容性' }).click()
  await expect(notice.getByRole('alert')).toHaveText('当前保存的配置仍不兼容，请修复后重试。')
  await expect(notice).toContainText('合成供应商配置尚不兼容。')
  await expect(notice.getByRole('button', { name: '重新检查兼容性' })).toBeEnabled()
  expect(fixture.retries).toEqual([{ objectKind: 'model-provider', objectId: 'deepseek' }])
  expect(fixture.snapshot().agents.find((agent) => agent.id === targetAgentId)!.model).toEqual(originalModel)
  expect(fixture.pageErrors).toEqual([])
  expect(fixture.unexpected).toEqual([])
})

test('an upgraded Host blocks an old page mutation and preserves the channel draft', async ({ page }, testInfo) => {
  const fixture = await installUpgradeHost(page)
  await page.goto(`/work/channels/${targetChannelId}`)
  const input = page.getByRole('textbox', { name: '消息内容' })
  await input.fill('升级期间尚未发送的合成草稿')
  fixture.changeRelease(`${fixture.snapshot().productMetadata!.releaseId}-next`)
  await input.press('Enter')
  await expect(page.locator('[data-release-mismatch]')).toContainText('服务已升级，请刷新页面')
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue('升级期间尚未发送的合成草稿')
  expect(fixture.messages).toEqual([])
  await testInfo.attach('upgrade-release-blocked', { body: await page.screenshot(), contentType: 'image/png' })
  expect(fixture.pageErrors).toEqual([])
  expect(fixture.unexpected).toEqual([])
})

test('a same-release refresh restores a draft and permits its first real send', async ({ page }) => {
  const fixture = await installUpgradeHost(page)
  await page.goto(`/work/channels/${targetChannelId}`)
  const input = page.getByRole('textbox', { name: '消息内容' })
  await input.fill('刷新后继续编辑的合成草稿')
  await page.reload()
  await expect(input).toHaveValue('刷新后继续编辑的合成草稿')
  await input.press('Enter')
  await expect.poll(() => fixture.messages.length).toBe(1)
  await expect(input).toHaveValue('')
  await expect(page.locator('[data-release-mismatch]')).toHaveCount(0)
  expect(fixture.pageErrors).toEqual([])
  expect(fixture.unexpected).toEqual([])
})
