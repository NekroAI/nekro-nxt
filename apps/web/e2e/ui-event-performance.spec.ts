import { expect, test, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChannelFactSseDataSchema } from '@nekro-nxt/contracts'
import { productSnapshot, targetChannelId, internalConnectionId } from './fixtures/product-quality.js'

// Timing runs exclude Playwright tracing/snapshots; diagnostic traces are separate.
test.use({ trace: 'off' })

const output = process.env['NEKRO_UI_PERF_OUTPUT']
const base = process.env['NEKRO_UI_PERF_URL'] ?? 'http://127.0.0.1:4970'
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function withEventFixture(page: Page, use: (emit: (channel: number) => void) => Promise<void>) {
  const streams = new Set<ServerResponse>()
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })
    response.write(': fictional performance fixture\n\n')
    streams.add(response)
    response.on('close', () => streams.delete(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const channel = productSnapshot.channels.find((item) => item.id === targetChannelId)!
  const idFor = (index: number) => (index === 0 ? targetChannelId : `chn_pressure${index}`)
  const message = (index: number, number: number) => ({
    id: `evt_pressure${index}n${number}`,
    channelId: idFor(index),
    role: 'member',
    occurredAt: 1_725_000_000_000 + number,
    parts: [{ type: 'text', text: `虚构压力消息 ${index}/${number}` }],
  })
  const snapshot = {
    ...productSnapshot,
    extensions: [],
    dynamic: [],
    authoringTasks: [],
    hostUi: { preferencesRevision: 0, pages: [] },
    channels: Array.from({ length: 200 }, (_, index) => ({
      ...channel,
      id: idFor(index),
      displayName: `压力频道 ${index}`,
    })),
    messages: Array.from({ length: 20 }, (_, index) =>
      Array.from({ length: 50 }, (_, number) => message(index, number)),
    ).flat(),
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('nekro-nxt.theme', 'dark')
    localStorage.setItem('nekro-nxt.reduced-motion', 'false')
  })
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const json = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (url.pathname === '/api/events') return route.continue({ url: `http://127.0.0.1:${address.port}/events` })
    if (url.pathname === '/api/snapshot') return json(snapshot)
    if (url.pathname.endsWith('/messages'))
      return json({
        cursor: { epoch: 'fixture', sequence: 0 },
        hasMore: false,
        messages: snapshot.messages.filter((item) => url.pathname.split('/')[3] === item.channelId),
      })
    if (url.pathname.endsWith('/runtime'))
      return json({
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: url.pathname.split('/')[3],
        phase: 'idle',
        summary: '当前空闲',
        pendingInjectCount: 0,
        turns: [],
      })
    return json({})
  })
  let sequence = 0
  const revisions = new Map<number, number>()
  try {
    await use((index) => {
      const revision = (revisions.get(index) ?? 0) + 1
      revisions.set(index, revision)
      const fact = ChannelFactSseDataSchema.parse({
        channelId: idFor(index),
        revision,
        items: [
          {
            kind: 'inbound',
            sourceId: `evt_pressure${index}n${50 + revision}`,
            message: message(index, 50 + revision),
          },
        ],
      })
      const frame = `id: fixture:${++sequence}\nevent: channel-fact\ndata: ${JSON.stringify(fact)}\n\n`
      // Every event is a real, schema-valid small SSE frame; history comes from REST.
      if (Buffer.byteLength(frame) > 4096) throw new Error('Pressure fixture exceeded its small-frame budget')
      for (const stream of streams) stream.write(frame)
    })
  } finally {
    await page.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

test('records 200-channel event pressure through a persistent SSE connection', async ({ page, browser }) => {
  test.skip(!output, 'Opt-in production performance run')
  test.setTimeout(180_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const results: unknown[] = []
  await withEventFixture(page, async (emit) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    for (let run = 0; run < 6; run += 1) {
      await page.goto(`${base}/work/channels/${targetChannelId}`)
      await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled()
      const before = await cdp.send('Performance.getMetrics')
      let emitted = 0
      const started = performance.now()
      const timer = setInterval(() => {
        const due = Math.min(200, Math.floor((performance.now() - started) / 50))
        while (emitted < due) emit(emitted++ % 20)
      }, 10)
      try {
        const timing = await page.evaluate(async () => {
          const frames: number[] = []
          const tasks: number[] = []
          const observer = new PerformanceObserver((list) =>
            tasks.push(...list.getEntries().map((entry) => entry.duration)),
          )
          observer.observe({ type: 'longtask' })
          const start = performance.now()
          let last = start
          await new Promise<void>((resolve) => {
            const tick = (now: number) => {
              frames.push(now - last)
              last = now
              if (now - start >= 10_000) resolve()
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          })
          observer.disconnect()
          return { frames, tasks, elapsed: performance.now() - start, elements: document.querySelectorAll('*').length }
        })
        const after = await cdp.send('Performance.getMetrics')
        expect(emitted).toBe(200)
        await expect(page.locator('[data-channel-message-list] article')).toHaveCount(60)
        results.push({ run, warmup: run === 0, emitted, timing, before, after })
      } finally {
        clearInterval(timer)
      }
    }
  })
  expect(failures).toEqual([])
  await mkdir(output!, { recursive: true })
  await writeFile(join(output!, 'events.json'), JSON.stringify({ browser: browser.version(), base, results }, null, 2))
})

test('records three-page directory refresh under continuous invalidation', async ({ page }) => {
  test.skip(!output, 'Opt-in production performance run')
  test.setTimeout(120_000)
  const results: unknown[] = []
  await withEventFixture(page, async (emit) => {
    let version = 0
    let started = 0
    const completions: number[] = []
    await page.route('**/api/platform-users*', async (route) => {
      const url = new URL(route.request().url())
      const cursor = url.searchParams.get('cursor')
      const offset = cursor === 'pid_cursor50' ? 50 : cursor === 'pid_cursor100' ? 100 : 0
      const requestVersion = version
      await delay(500)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 150,
          items: Array.from({ length: 50 }, (_, index) => ({
            identityId: `pid_pressure${offset + index}`,
            displayName: `成员 ${offset + index} v${requestVersion}`,
            adapter: { key: 'fixture-alpha', displayName: '内置频道' },
            connection: { id: internalConnectionId, displayName: '测试连接' },
            activeChannelCount: 0,
            channelPreview: [],
            historicalOnly: false,
          })),
          facets: { adapters: [], connections: [] },
          ...(offset < 100 ? { nextCursor: `pid_cursor${offset + 50}` } : {}),
        }),
      })
      if (started) completions.push(performance.now() - started)
    })
    for (let run = 0; run < 6; run += 1) {
      version = 0
      started = 0
      completions.length = 0
      await page.goto(`${base}/users`)
      await expect(page.getByText('成员 0 v0', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '加载更多' }).click()
      await expect(page.getByText('已显示 100 / 150')).toBeVisible()
      await page.getByRole('button', { name: '加载更多' }).click()
      await expect(page.getByText('已显示 150 / 150')).toBeVisible()
      version = 1
      started = performance.now()
      emit(0)
      const timer = setInterval(() => emit(0), 100)
      try {
        const refreshed = await page
          .getByText('成员 0 v1', { exact: true })
          .waitFor({ state: 'visible', timeout: 2500 })
          .then(
            () => true,
            () => false,
          )
        results.push({
          run,
          warmup: run === 0,
          refreshed,
          elapsed: performance.now() - started,
          completions: [...completions],
        })
      } finally {
        clearInterval(timer)
        started = 0
      }
    }
  })
  await mkdir(output!, { recursive: true })
  await writeFile(join(output!, 'directory.json'), JSON.stringify({ base, results }, null, 2))
})
