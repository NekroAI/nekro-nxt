import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const task = (id: string, label: string, extra: Record<string, unknown>) => ({
  id,
  agentId: targetAgentId,
  channelId: targetChannelId,
  source: 'chat',
  label,
  schedule: { kind: 'cron', cron: '0 8 * * *', timezone: 'Asia/Shanghai' },
  state: 'scheduled',
  nextRunAt: Date.now() + 3_600_000,
  createdAt: 1,
  ...extra,
})

const snapshot = HostApiContracts.snapshot.parseResponse({
  ...productSnapshot,
  scheduledTasks: [
    task('job_morning', '早安提醒', {}),
    task('job_check', '陪伴主动联系检查', { source: 'declared', extensionId: 'ext_companion', extensionName: '陪伴' }),
    task('job_post', '空间定时发布', {
      source: 'declared',
      extensionId: 'ext_space',
      extensionName: '空间助手',
      state: 'inactive',
    }),
  ],
})

for (const width of [375, 1440]) {
  test(`an agent's tasks are grouped by source and a disabled extension's tasks stay out of the list (${width}px)`, async ({
    page,
  }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await installSnapshotHealthRoutes(page, snapshot)
    await installWorkspaceRoutes(page, () => snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/agents/${targetAgentId}#profile-schedules`)

    const chat = page.getByRole('button', { name: /^对话创建/u })
    const companion = page.getByRole('button', { name: /^陪伴/u })
    await expect(chat).toHaveAttribute('aria-expanded', 'true')
    await expect(companion).toContainText('由这个扩展创建，在扩展配置中关闭；这里只能暂停')
    await expect(page.getByText('早安提醒')).toBeVisible()
    await expect(page.getByText('陪伴主动联系检查')).toBeVisible()
    await expect(page.getByText('空间定时发布')).toHaveCount(0)
    await expect(page.getByText('另有 1 个任务来自已停用的扩展，重新启用扩展后恢复。')).toBeVisible()

    await companion.click()
    await expect(companion).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('陪伴主动联系检查')).toBeHidden()
    await expect(page.getByText('早安提醒')).toBeVisible()
    await page.screenshot({ path: `.local/scheduled-task-groups-${width}.png`, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  })
}
