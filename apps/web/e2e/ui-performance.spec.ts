import { test, expect } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { platform, release, cpus } from 'node:os'
import { execFileSync } from 'node:child_process'
import { productSnapshot, targetChannelId, targetAgentId, imageAssetId } from './fixtures/product-quality.js'

declare global {
  interface Window {
    __uiPerfStop?: () => { frames: number[]; longTasks: number[]; events: number[] }
  }
}

// Opt-in: production timing must not share a busy CI worker with functional tests.
// Timing runs exclude Playwright tracing/snapshots; diagnostic traces are separate.
test.use({ trace: 'off' })

const output = process.env['NEKRO_UI_PERF_OUTPUT']
const mixed = process.env['NEKRO_UI_PERF_MIXED'] === '1'
const base = process.env['NEKRO_UI_PERF_URL'] ?? 'http://127.0.0.1:4970'

test('records repeatable production interaction costs with fictional history', async ({ page, browser }, testInfo) => {
  test.skip(!output, 'Set NEKRO_UI_PERF_OUTPUT to record a production comparison.')
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const results: unknown[] = []
  const channel = productSnapshot.channels.find((item) => item.id === targetChannelId)!
  let count = 50
  const snapshot = {
    ...productSnapshot,
    extensions: [],
    dynamic: [],
    authoringTasks: [],
    hostUi: { preferencesRevision: 0, pages: [] },
    channels: Array.from({ length: 20 }, (_, index) => ({
      ...channel,
      id: index === 0 ? targetChannelId : `chn_perf${index}`,
      displayName: `性能测试频道 ${index}`,
    })),
  }
  await page.addInitScript(() => {
    localStorage.setItem('nekro-nxt.theme', 'dark')
    localStorage.setItem('nekro-nxt.reduced-motion', 'false')
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    // Leave the stream open. Fulfilling a finite SSE body would repeatedly reconnect
    // and reload history, contaminating steady-state interaction measurements.
    if (url.pathname.endsWith(`/assets/${imageAssetId}`))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180"><rect width="360" height="180" fill="#e2e8f2"/><circle cx="90" cy="90" r="44" fill="#7390c0"/></svg>',
      })
    if (url.pathname === '/api/events') return
    if (url.pathname === '/api/snapshot') return json(snapshot)
    if (url.pathname.endsWith('/messages'))
      return json({
        cursor: { epoch: 'fixture', sequence: 0 },
        hasMore: false,
        messages: Array.from({ length: count }, (_, i) => ({
          id: `evt_perf${i}`,
          channelId: targetChannelId,
          role: 'member',
          occurredAt: 1_725_000_000_000 + i,
          parts: [
            ...(mixed && i % 10 === 0 ? [{ type: 'image', assetId: imageAssetId, alt: `虚构图示 ${i}` }] : []),
            {
              type: 'text',
              text:
                i % 5 === 0
                  ? `**记录 ${i}**\n\n| 项目 | 内容 |\n| --- | --- |\n| 示例 | 保留查找和选择 |`
                  : `性能测试消息 ${i}：这是一条虚构的讨论记录。`,
            },
          ],
        })),
      })
    if (url.pathname.endsWith('/runtime'))
      return json({
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        agentId: targetAgentId,
        phase: 'idle',
        summary: '当前空闲',
        pendingInjectCount: 0,
        occupancy: {
          projectedTokens: 46320,
          contextWindow: 128000,
          breakdown: { systemTokens: 8200, toolsTokens: 12120, messageTokens: 26000 },
        },
        turns: Array.from({ length: 24 }, (_, i) => ({
          turn: i + 1,
          state: 'completed',
          producedReply: true,
          responseState: 'finished',
          steps: Array.from({ length: 8 }, (_, j) => ({
            step: j + 1,
            tools: mixed
              ? [
                  {
                    callId: `call_perf${i}n${j}`,
                    name: 'inspect_fixture',
                    displayName: '检查虚构资料',
                    state: 'succeeded',
                    inputPreview: JSON.stringify({ document: `资料-${i}-${j}`, sections: [1, 2, 3] }),
                    resultPreview: `已核对资料。${'这里是虚构的工具结果说明。'.repeat(32)}`,
                  },
                ]
              : [],
            internalOutput: { kind: 'internal-output', text: `第 ${i + 1} 轮第 ${j + 1} 步的内部记录。` },
          })),
        })),
      })
    return json({})
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const requestedSize = process.env['NEKRO_UI_PERF_SIZE']
  const sizes = requestedSize
    ? [Number(requestedSize)]
    : process.env['NEKRO_UI_PERF_THEME'] === '1'
      ? [1000]
      : [50, 1000, 5000]
  if (sizes.some((size) => ![50, 1000, 5000].includes(size))) throw new Error('Unsupported performance size')
  for (const size of sizes) {
    count = size
    await page.goto(`${base}/work/channels/${targetChannelId}`)
    await expect(page.locator('[data-channel-message-list] article')).toHaveCount(size, { timeout: 60_000 })
    await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled()
    if (process.env['NEKRO_UI_PERF_CONTENT_VISIBILITY'] === '1') {
      await page.addStyleTag({
        content:
          '[data-channel-message-list] [data-nxt-enter-kind="object"] { content-visibility: auto; contain-intrinsic-size: auto 120px; }',
      })
    }
    if (process.env['NEKRO_UI_PERF_LAYOUT_CONTAIN'] === '1') {
      await page.addStyleTag({
        content: '[data-channel-message-list] [data-nxt-enter-kind="object"] { contain: layout; }',
      })
    }
    for (let run = 0; run < 6; run += 1) {
      const before = await cdp.send('Performance.getMetrics')
      await page.evaluate(() => {
        const state = {
          frames: [] as number[],
          longTasks: [] as number[],
          events: [] as number[],
          last: performance.now(),
          running: true,
        }
        Object.assign(window, { __uiPerf: state })
        const tick = (now: number) => {
          if (!state.running) return
          state.frames.push(now - state.last)
          state.last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
        })
        observer.observe({ type: 'longtask', buffered: false })
        const events = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.events.push(entry.duration)
        })
        events.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
        Object.assign(window, {
          __uiPerfStop: () => {
            state.running = false
            observer.disconnect()
            events.disconnect()
            return state
          },
        })
      })
      if (process.env['NEKRO_UI_PERF_THEME'] === '1') {
        for (const name of ['主题：深色；切换为浅色', '主题：浅色；切换为深色']) {
          await page.getByRole('button', { name }).click()
          await page.waitForTimeout(500)
        }
      } else {
        await page.getByRole('textbox', { name: '消息内容' }).pressSequentially('性能测试输入', { delay: 20 })
        await page.getByRole('textbox', { name: '消息内容' }).fill('')
        const splitter = page.getByRole('separator', { name: '调整检查器宽度' })
        const box = await splitter.boundingBox()
        if (!box) throw new Error('Missing inspector splitter')
        await page.mouse.move(box.x + box.width / 2, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x - 100, box.y + 100, { steps: 30 })
        await page.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 30 })
        await page.mouse.up()
        await page.locator('[data-channel-message-list]').hover()
        await page.mouse.wheel(0, -500)
        await page.mouse.wheel(0, 500)
      }
      const timings = await page.evaluate(() => {
        const stop = window.__uiPerfStop
        if (!stop) throw new Error('Missing performance recorder')
        const state = stop()
        const sorted = [...state.frames].sort((a, b) => a - b)
        return {
          ...state,
          p95Frame: sorted[Math.floor(sorted.length * 0.95)],
          elements: document.querySelectorAll('*').length,
        }
      })
      const after = await cdp.send('Performance.getMetrics')
      results.push({ size, run, warmup: run === 0, timings, before, after })
    }
  }
  expect(failures).toEqual([])
  const environment = await page.evaluate(async () => {
    const samples: number[] = []
    let last = performance.now()
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        samples.push(now - last)
        last = now
        if (samples.length === 30) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    samples.sort((a, b) => a - b)
    return {
      devicePixelRatio,
      userAgent: navigator.userAgent,
      idleFrameMedian: samples[15],
      entryAssets: [...document.scripts].map((script) => script.src).filter(Boolean),
    }
  })
  await mkdir(output!, { recursive: true })
  await writeFile(
    join(output!, 'interactions.json'),
    JSON.stringify(
      {
        mixed,
        layoutContainExperiment: process.env['NEKRO_UI_PERF_LAYOUT_CONTAIN'] === '1',
        scenario: process.env['NEKRO_UI_PERF_THEME'] === '1' ? 'theme' : 'history',
        headless: testInfo.project.use.headless ?? true,
        environment,
        contentVisibilityExperiment: process.env['NEKRO_UI_PERF_CONTENT_VISIBILITY'] === '1',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        browser: browser.version(),
        viewport: { width: 1440, height: 900 },
        scale: 1,
        theme: 'dark',
        results,
      },
      null,
      2,
    ),
  )
  await page.screenshot({ path: join(output!, 'history-dark.png') })
  if (process.env['NEKRO_UI_PERF_TRACE'] === '1') {
    // Diagnostics follow all timed samples and never contribute to their metrics.
    count = 1000
    await page.goto(`${base}/work/channels/${targetChannelId}`)
    await expect(page.locator('[data-channel-message-list] article')).toHaveCount(count)
    const complete = new Promise<string>((resolve, reject) =>
      cdp.once('Tracing.tracingComplete', (event) => {
        if (event.stream) resolve(event.stream)
        else reject(new Error('Missing diagnostic trace stream'))
      }),
    )
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,cc,gpu',
      transferMode: 'ReturnAsStream',
    })
    await page.evaluate(() => performance.mark('ui-perf:drag-start'))
    const splitter = page.getByRole('separator', { name: '调整检查器宽度' })
    const box = await splitter.boundingBox()
    if (!box) throw new Error('Missing diagnostic splitter')
    await page.mouse.move(box.x + box.width / 2, box.y + 100)
    await page.mouse.down()
    await page.mouse.move(box.x - 100, box.y + 100, { steps: 30 })
    await page.mouse.up()
    await page.evaluate(() => performance.mark('ui-perf:theme-start'))
    await page.getByRole('button', { name: '主题：深色；切换为浅色' }).click()
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)))
    await page.evaluate(() => performance.mark('ui-perf:diagnostic-end'))
    await cdp.send('Tracing.end')
    const handle = await complete
    const chunks: Buffer[] = []
    for (;;) {
      const part = await cdp.send('IO.read', { handle })
      chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'))
      if (part.eof) break
    }
    await cdp.send('IO.close', { handle })
    await writeFile(join(output!, 'material-diagnostic.json'), Buffer.concat(chunks))
  }
})
