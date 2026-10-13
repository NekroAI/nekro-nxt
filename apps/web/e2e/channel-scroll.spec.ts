import { createServer, type ServerResponse } from 'node:http'
import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelFactSseDataSchema,
  HostApiContracts,
  type HostSnapshotMessage,
} from '@nekro-nxt/contracts'
import { expect, test, type Page } from '@playwright/test'
import { productSnapshot, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const message = (index: number): HostSnapshotMessage => ({
  id: ChannelEventIdSchema.parse(`evt_scroll${index < 0 ? `old${-index}` : index}`),
  channelId: targetChannelId,
  role: 'member',
  occurredAt: 1_725_000_000_000 + index * 1000,
  parts: [{ type: 'text', text: `虚构滚动消息 ${index}` }],
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function withScrollFixture(
  page: Page,
  use: (fixture: {
    readonly historyStarted: Promise<void>
    readonly releaseHistory: () => void
    readonly imageStarted: Promise<void>
    readonly releaseImage: () => void
    readonly connected: () => boolean
    readonly emit: (value: HostSnapshotMessage) => void
  }) => Promise<void>,
) {
  const historyStarted = deferred()
  const history = deferred()
  const imageStarted = deferred()
  const image = deferred()
  const streams = new Set<ServerResponse>()
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })
    response.write(': fictional scroll fixture\n\n')
    streams.add(response)
    response.on('close', () => streams.delete(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const snapshot = HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    extensions: [],
    dynamic: [],
    authoringTasks: [],
    hostUi: { preferencesRevision: 0, pages: [] },
    messages: [],
  })
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/events', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/events` }))
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
  await page.route(`**/api/channels/${targetChannelId}/messages?*`, async (route) => {
    const older = new URL(route.request().url()).searchParams.has('beforeSourceId')
    if (older) {
      historyStarted.resolve()
      await history.promise
    }
    await route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        hasMore: !older,
        messages: Array.from({ length: 40 }, (_, index) => message(older ? index - 40 : index)),
      },
    })
  })
  await page.route(`**/api/channels/${targetChannelId}/assets/ast_SCROLLIMAGE`, async (route) => {
    imageStarted.resolve()
    await image.promise
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#48758b"/><circle cx="200" cy="200" r="100" fill="#e8ce8e"/></svg>',
    })
  })
  let revision = 0
  try {
    await use({
      historyStarted: historyStarted.promise,
      releaseHistory: history.resolve,
      imageStarted: imageStarted.promise,
      releaseImage: image.resolve,
      connected: () => streams.size > 0,
      emit: (value) => {
        const fact = ChannelFactSseDataSchema.parse({
          channelId: targetChannelId,
          revision: ++revision,
          items: [{ kind: 'inbound', sourceId: value.id, message: value }],
        })
        for (const stream of streams)
          stream.write(`id: fixture:${revision}\nevent: channel-fact\ndata: ${JSON.stringify(fact)}\n\n`)
      },
    })
  } finally {
    history.resolve()
    image.resolve()
    await page.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`jump overrides delayed history loading (${theme}, ${width}px)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
      await withScrollFixture(page, async (fixture) => {
        await page.goto(`/channels/${targetChannelId}`)
        const log = page.getByRole('log', { name: '消息记录' })
        const jump = page.getByRole('button', { name: '回到最新', exact: true })
        const distance = () =>
          log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
        await expect(page.getByText('虚构滚动消息 39', { exact: true })).toBeInViewport()
        await expect.poll(fixture.connected).toBe(true)
        await log.hover()
        await page.mouse.wheel(0, -100000)
        await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toBeInViewport()
        await page.getByRole('button', { name: '加载更早的消息', exact: true }).click()
        await fixture.historyStarted
        await jump.click()
        await expect.poll(distance).toBeLessThanOrEqual(1)
        await expect(jump).toBeHidden()
        fixture.releaseHistory()
        await expect(page.getByText('虚构滚动消息 -40', { exact: true })).toBeAttached()
        // The old request must not replace the newer explicit decision to follow the bottom.
        await expect.poll(distance).toBeLessThanOrEqual(1)
        await expect(jump).toBeHidden()

        for (let index = 40; index <= 42; index++) {
          fixture.emit(message(index))
          await expect(page.getByText(`虚构滚动消息 ${index}`, { exact: true })).toBeInViewport()
          await expect.poll(distance).toBeLessThanOrEqual(1)
        }
        fixture.emit({
          ...message(43),
          parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_SCROLLIMAGE'), alt: '虚构延迟图片' }],
        })
        await fixture.imageStarted
        fixture.releaseImage()
        const picture = page.getByRole('img', { name: '虚构延迟图片', exact: true })
        await expect
          .poll(() => picture.evaluate((element) => element instanceof HTMLImageElement && element.naturalHeight))
          .toBe(500)
        await expect.poll(distance).toBeLessThanOrEqual(1)
        await page.getByRole('textbox', { name: '消息' }).fill('虚构草稿第一行\n第二行\n第三行\n第四行\n第五行\n第六行')
        await expect.poll(distance).toBeLessThanOrEqual(1)
        await expect(picture).toBeInViewport()
        await page.screenshot({ path: testInfo.outputPath(`follow-${theme}-${width}.png`), animations: 'disabled' })

        await log.hover()
        await page.mouse.wheel(0, -800)
        await expect(jump).toBeVisible()
        const top = await log.evaluate((element) => element.scrollTop)
        fixture.emit(message(44))
        await expect(page.getByText('虚构滚动消息 44', { exact: true })).toBeAttached()
        expect(Math.abs((await log.evaluate((element) => element.scrollTop)) - top)).toBeLessThanOrEqual(1)
        await expect(jump).toBeVisible()
        await jump.click()
        await expect.poll(distance).toBeLessThanOrEqual(1)
        await expect(jump).toBeHidden()
        expect(errors).toEqual([])
      })
    })
  }
}

test('loading older history preserves the reading position when the user does not jump', async ({ page }) => {
  await withScrollFixture(page, async (fixture) => {
    await page.goto(`/channels/${targetChannelId}`)
    const log = page.getByRole('log', { name: '消息记录' })
    await expect(page.getByText('虚构滚动消息 39', { exact: true })).toBeInViewport()
    await log.hover()
    await page.mouse.wheel(0, -100000)
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).click()
    await fixture.historyStarted
    const anchor = page.getByText('虚构滚动消息 0', { exact: true })
    const before = await anchor.boundingBox()
    fixture.releaseHistory()
    await expect(page.getByText('虚构滚动消息 -40', { exact: true })).toBeAttached()
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(40)
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
  })
})
