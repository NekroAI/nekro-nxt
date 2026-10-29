import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test, type Page } from '@playwright/test'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { productSnapshot, targetAgentId, targetChannelId, targetEpisodeId } from './fixtures/product-quality.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const at = 1_725_000_000_000

const failedTurn = (turn: number) => ({
  turn,
  state: 'error',
  producedReply: false,
  responseState: 'pending',
  error: { code: 'TRANSPORT', message: '模型请求没有发出去' },
  startedAt: at + turn * 60_000,
  endedAt: at + turn * 60_000 + 40,
  durationMs: 40,
  steps: [],
})

const install = async (page: Page, failures: number) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const snapshot = HostApiContracts.snapshot.parseResponse(productSnapshot)
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/channels/*/runtime', (route) =>
    route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        agentId: targetAgentId,
        episodeId: targetEpisodeId,
        phase: 'unavailable',
        summary: '智能体本轮失败：模型请求没有发出去',
        pendingInjectCount: 0,
        turns: [
          { ...failedTurn(1), state: 'completed', responseState: 'finished', error: undefined },
          ...Array.from({ length: failures }, (_, index) => failedTurn(index + 2)),
        ],
      },
    }),
  )
  await page.route('**/api/channels/*/messages?*', (route) =>
    route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false } }),
  )
  const resets: unknown[] = []
  await page.route(`**/api/channels/${targetChannelId}/context-reset`, (route) => {
    const input = HostApiContracts.resetChannelContext.request.parse(route.request().postDataJSON())
    resets.push(input)
    return route.fulfill({
      json: { mode: input.mode, closedEpisodeId: targetEpisodeId, nextEpisodeId: 'eps_targetnext' },
    })
  })
  return { errors, resets }
}

test('a failed turn offers compacting first', async ({ page }) => {
  const fixture = await install(page, 1)
  await page.goto(`/channels/${targetChannelId}`)
  const log = page.getByRole('log', { name: '消息记录' })
  const compact = log.getByRole('button', { name: '压缩上下文', exact: true })
  await expect(compact).toBeVisible()
  await expect(compact).toHaveClass(/primary/u)
  await expect(log.getByRole('button', { name: '清空上下文', exact: true })).not.toHaveClass(/primary/u)
  await expect(log.getByText('清空上下文通常能恢复', { exact: false })).toHaveCount(0)

  await compact.click()
  const dialog = page.getByRole('dialog', { name: '压缩上下文？' })
  await expect(dialog).toContainText('当前任务会停止，对话整理成摘要后继续。')
  await dialog.getByRole('button', { name: '压缩', exact: true }).click()
  await expect(page.getByText('已压缩上下文', { exact: true })).toBeVisible()
  expect(fixture.resets).toEqual([{ expectedEpisodeId: targetEpisodeId, mode: 'compact' }])
  expect(fixture.errors).toEqual([])
})

for (const width of [1440, 375]) {
  test(`repeated failures suggest clearing the context (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const fixture = await install(page, 3)
    await page.goto(`/channels/${targetChannelId}`)
    const log = page.getByRole('log', { name: '消息记录' })
    await expect(log.getByText('连续 3 轮失败，清空上下文通常能恢复。')).toBeVisible()
    // Only the latest failure carries the actions.
    await expect(log.getByRole('button', { name: '清空上下文', exact: true })).toHaveCount(1)
    const clear = log.getByRole('button', { name: '清空上下文', exact: true })
    await expect(clear).toHaveClass(/primary/u)
    await expect(log.getByRole('button', { name: '压缩上下文', exact: true })).not.toHaveClass(/primary/u)
    await page.screenshot({ path: `.local/channel-failure-recovery-${width}.png` })

    await clear.click()
    const dialog = page.getByRole('dialog', { name: '清空上下文？' })
    await expect(dialog).toContainText('当前任务会停止，从空白开始。聊天记录保留。')
    await dialog.getByRole('button', { name: '清空', exact: true }).click()
    await expect(page.getByText('已清空上下文', { exact: true })).toBeVisible()
    expect(fixture.resets).toEqual([{ expectedEpisodeId: targetEpisodeId, mode: 'clear' }])
    expect(fixture.errors).toEqual([])
  })
}
