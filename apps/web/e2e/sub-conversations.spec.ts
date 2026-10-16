import {
  HostApiContracts,
  SubConversationIdSchema,
  SubConversationSettingsSchema,
  type SubConversation,
} from '@nekro-nxt/contracts'
import { expect, test, type Page } from '@playwright/test'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { productSnapshot, targetAgentId, targetChannelId, targetEpisodeId } from './fixtures/product-quality.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const at = 1_725_000_000_000

const conversations: SubConversation[] = [
  {
    id: SubConversationIdSchema.parse('cnv_OPENFIXTURE'),
    channelId: targetChannelId,
    episodeId: targetEpisodeId,
    agentId: targetAgentId,
    title: '整理本周活动要点',
    openedBy: 'agent',
    driver: 'model',
    status: 'open',
    createdAt: at,
  },
  {
    id: SubConversationIdSchema.parse('cnv_CLOSEDFIXTURE'),
    channelId: targetChannelId,
    episodeId: targetEpisodeId,
    agentId: targetAgentId,
    title: '验证 weather_card',
    openedBy: 'host',
    driver: 'script',
    status: 'closed',
    closeReason: 'completed',
    summary: '验证调用已完成。',
    createdAt: at - 60_000,
    closedAt: at - 50_000,
  },
]

const runtimeOf = (conversation: SubConversation) => ({
  conversation,
  runtime: {
    channelId: targetChannelId,
    agentId: targetAgentId,
    episodeId: targetEpisodeId,
    phase: conversation.status === 'open' ? 'idle' : 'unavailable',
    summary: '',
    pendingInjectCount: 0,
    turns: [
      {
        turn: 1,
        state: 'completed',
        producedReply: false,
        responseState: 'not-required',
        startedAt: conversation.createdAt,
        endedAt: conversation.createdAt + 3_000,
        durationMs: 3_000,
        inputs: [
          {
            messageId: `${conversation.id}-task`,
            source: 'user',
            preview: conversation.title,
            at: conversation.createdAt,
          },
        ],
        steps: [
          {
            step: 1,
            tools: [
              {
                callId: `${conversation.id}-call`,
                name: 'conversation_history_search',
                displayName: '搜索聊天记录',
                state: 'succeeded',
                durationMs: 640,
                inputPreview: JSON.stringify({ query: '活动' }),
                resultPreview: '找到 4 条虚构记录。',
              },
            ],
          },
        ],
      },
    ],
  },
})

const install = async (page: Page) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const snapshot = HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    subConversations: conversations,
  })
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/channels/*/runtime', (route) =>
    route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        phase: 'idle',
        summary: '当前空闲',
        pendingInjectCount: 0,
        turns: [],
      },
    }),
  )
  await page.route('**/api/channels/*/messages?*', (route) =>
    route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false } }),
  )
  await page.route('**/api/sub-conversations/*/runtime', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const conversation = conversations.find((item) => item.id === id)
    return conversation ? route.fulfill({ json: runtimeOf(conversation) }) : route.fulfill({ status: 404, json: {} })
  })
  let retention = '7d'
  await page.route('**/api/settings/sub-conversations', async (route) => {
    if (route.request().method() === 'PUT') {
      retention = SubConversationSettingsSchema.parse(route.request().postDataJSON()).retention
    }
    await route.fulfill({ json: { retention } })
  })
  return { failures, retention: () => retention }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`sub-conversations sit under their channel and open read only (${theme}, ${width}px)`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
      const fixture = await install(page)
      await page.goto(`/channels/${targetChannelId}/conversations/cnv_OPENFIXTURE`)

      const group = page.getByRole('group', { name: '子对话' })
      // On a phone the list and the conversation are separate views; the list is checked on the desktop layout.
      const listed = width >= 1100
      if (listed) {
        await expect(group.getByRole('link', { name: /整理本周活动要点/u })).toBeVisible()
        // Ended ones are folded behind a count until opened.
        await expect(group.getByRole('link', { name: /验证 weather_card/u })).toHaveCount(0)
        await group.getByRole('button', { name: /已结束 1/u }).click()
        await expect(group.getByRole('link', { name: /验证 weather_card/u })).toBeVisible()
      }

      await expect(page.getByRole('heading', { name: /整理本周活动要点/u })).toBeVisible()
      await expect(page.getByText('搜索聊天记录').first()).toBeVisible()
      await expect(page.getByText('这里只能查看')).toBeVisible()
      await expect(page.getByRole('button', { name: '结束', exact: true })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`sub-conversation-open-${theme}-${width}.png`),
        fullPage: true,
      })

      if (listed) await group.getByRole('link', { name: /验证 weather_card/u }).click()
      else await page.goto(`/channels/${targetChannelId}/conversations/cnv_CLOSEDFIXTURE`)
      await expect(page.getByRole('heading', { name: /验证 weather_card/u })).toBeVisible()
      await expect(page.getByText('验证调用已完成。')).toBeVisible()
      await expect(page.getByRole('button', { name: '销毁', exact: true })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`sub-conversation-closed-${theme}-${width}.png`),
        fullPage: true,
      })
      expect(fixture.failures).toEqual([])
    })
  }
}

test('keeps ended sub-conversations for the chosen time', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/settings/conversations')
  const retention = page.getByRole('radiogroup', { name: '结束后保留' })
  await expect(retention).toBeVisible()
  await retention.getByRole('radio', { name: '30 天' }).click()
  await expect.poll(fixture.retention).toBe('30d')
  expect(fixture.failures).toEqual([])
})
