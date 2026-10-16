import { hostLogStatusSchema } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let child: ChildProcessWithoutNullStreams
let root: string
let origin: string
test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nxt-log-journey-'))
  const serverUrl = pathToFileURL(path.resolve('apps/server/dist/main.mjs')).href
  const storageUrl = pathToFileURL(path.resolve('packages/storage-sqlite/dist/index.mjs')).href
  const script = `
    import { mkdir } from 'node:fs/promises';
    import { startNekroServer } from ${JSON.stringify(serverUrl)};
    import { LogDatabase } from ${JSON.stringify(storageUrl)};
    const root=${JSON.stringify(root)};
    await mkdir(root+'/logs',{recursive:true});
    const db=new LogDatabase(root+'/logs/logs.sqlite',{retentionDays:7,maxSizeMiB:256,revision:0});
    const record=(message, level='info', scope={})=>({runId:'fictional-run',timestamp:new Date().toISOString(),level,message,source:{kind:'extension',id:'ext_log_demo',name:'示例扩展',version:'示例版本'},scope,redacted:false,truncated:false});
    db.append([...Array.from({length:650},(_,i)=>record('批量模拟连接恢复 '+i+'。')), ...Array.from({length:40},()=>record('虚构重复重试记录')),record('虚构连接请求开始','info',{operationId:'fictional-operation'}),{...record('虚构连接请求超时','error',{operationId:'fictional-operation'}),details:{code:'DEMO_TIMEOUT',stack:'Error: synthetic timeout\\n    at reconnect (demo-adapter.ts:12:4)'}}]);
    db.close();
    let logger;
    const server=await startNekroServer({dataRoot:root,distIndex:${JSON.stringify(path.resolve('apps/web/dist/index.html'))},port:0,configureLlm(context){logger=context.logger('fictional-live');}});
    process.stdout.write('PORT='+server.port+'\\n');
    process.stdin.setEncoding('utf8'); process.stdin.on('data', value=>{if(value.includes('emit'))logger.info('虚构实时追加记录');});
    process.on('SIGTERM',()=>void server.stop().then(()=>process.exit(0)));
  `
  child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, NEKRO_LLM_PROVIDERS: '' },
    stdio: 'pipe',
  })
  origin = await new Promise<string>((resolve, reject) => {
    let output = ''
    let diagnostics = ''
    const timer = setTimeout(
      () => reject(new Error(`Log fixture startup timeout: ${diagnostics.slice(-1500)}`)),
      30_000,
    )
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString()
    })
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const port = /PORT=(\d+)/u.exec(output)?.[1]
      if (port) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${port}`)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Log fixture exited ${code}: ${diagnostics.slice(-1500)}`))
    })
  })
})
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
  if (root) await rm(root, { recursive: true, force: true })
})

test('production log journey: history, details, repeats, export, live pause, settings and responsive themes', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}/logs`)
  await expect(page.getByRole('heading', { name: '日志', exact: true })).toBeVisible()
  const search = page.getByRole('textbox', { name: '搜索日志' })
  await search.fill('虚构连接请求超时')
  await expect(page.getByText(/1 条已加载/u)).toBeVisible()
  const errorRow = page.getByRole('gridcell', { name: '错误 示例扩展 虚构连接请求超时' })
  await expect(errorRow).toBeVisible()
  await errorRow.click()
  await expect(page.getByRole('complementary', { name: '日志详情' })).toContainText('DEMO_TIMEOUT')
  await mkdir(path.resolve('.local/logs-visual'), { recursive: true })
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/light-wide.png') })
  await page.getByRole('button', { name: '查看相关日志', exact: true }).click()
  await expect(page.getByRole('gridcell', { name: '信息 示例扩展 虚构连接请求开始' })).toBeVisible()
  await expect(page.getByRole('gridcell', { name: '错误 示例扩展 虚构连接请求超时' })).toBeVisible()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await search.fill('虚构重复重试记录')
  await expect(page.getByRole('button', { name: '展开 40 条重复日志' })).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.getByRole('menuitem', { name: '文本' }).click()
  const download = await downloaded
  const file = await download.path()
  expect(file).not.toBeNull()
  expect((await readFile(file, 'utf8')).match(/虚构重复重试记录/gu)).toHaveLength(40)
  await page.getByRole('button', { name: '展开 40 条重复日志' }).click()
  await expect(page.getByRole('button', { name: '折叠 40 条重复日志' })).toBeVisible()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await search.fill('虚构')
  await expect(page.getByText(/42 条已加载/u)).toBeVisible()
  await page.getByRole('button', { name: '回到最新', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停跟随', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停跟随', exact: true }).click()
  const position = await page.getByRole('grid', { name: '运行日志' }).evaluate((element) => element.scrollTop)
  child.stdin.write('emit\n')
  await expect(page.getByRole('button', { name: /新增 \d+ 条/u })).toBeVisible()
  expect(await page.getByRole('grid', { name: '运行日志' }).evaluate((element) => element.scrollTop)).toBe(position)
  await page.getByRole('button', { name: /新增 \d+ 条/u }).click()
  await expect(page.getByRole('gridcell', { name: /虚构实时追加记录/u })).toBeVisible()
  await page.getByRole('button', { name: '全局临时调试', exact: true }).click()
  await page.getByRole('menuitem', { name: '采集 15 分钟' }).click()
  await expect(page.getByRole('button', { name: '结束调试' })).toBeVisible()
  await page.getByRole('button', { name: '结束调试' }).click()
  await expect(page.getByRole('button', { name: '结束调试' })).toHaveCount(0)
  const before = await request
    .get(`${origin}/api/logs/status`)
    .then(async (response) => hostLogStatusSchema.parse(await response.json()))
  await page.getByRole('button', { name: '清空视图', exact: true }).click()
  await expect(page.getByText('清空后还没有新日志', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '显示之前的日志' })).toBeVisible()
  const after = await request
    .get(`${origin}/api/logs/status`)
    .then(async (response) => hostLogStatusSchema.parse(await response.json()))
  expect(after.count).toBeGreaterThanOrEqual(before.count)
  await page.goto(`${origin}/settings/logs`)
  await page.getByRole('combobox', { name: '保留时间' }).click()
  await page.getByRole('option', { name: '3 天', exact: true }).click()
  await page.getByRole('region', { name: '未保存的修改' }).getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '保存并清理旧日志', exact: true }).click()
  // Once saved there is nothing left to save, so the save bar goes away.
  await expect(page.getByRole('region', { name: '未保存的修改' })).toHaveCount(0)
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/settings.png') })
  await page.goto(`${origin}/logs?query=${encodeURIComponent(JSON.stringify({ keyword: '虚构连接请求超时' }))}`)
  await page.evaluate(() => localStorage.setItem('nekro-nxt.theme', 'dark'))
  await page.reload()
  await expect(errorRow).toBeVisible()
  await errorRow.click()
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/dark-wide.png') })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/dark-compact-width.png') })
  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.getByRole('dialog', { name: '日志详情' })).toBeVisible()
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/dark-narrow-detail.png') })
  await page.getByRole('dialog', { name: '日志详情' }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '日志详情' })).toBeHidden()
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        ),
  )
  await page.screenshot({ path: path.resolve('.local/logs-visual/dark-narrow.png') })
  expect(errors).toEqual([])
  expect(await page.locator('html').evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
})

test('large log lists scroll independently at desktop and narrow window sizes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/logs?query=${encodeURIComponent(JSON.stringify({ keyword: '批量模拟连接恢复' }))}`)
  const grid = page.getByRole('grid', { name: '运行日志' })
  await expect(page.getByRole('gridcell').last()).toContainText('批量模拟连接恢复 649')
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1100, height: 720 },
    { width: 720, height: 640 },
    { width: 390, height: 720 },
  ]) {
    await page.setViewportSize(size)
    const search = page.getByRole('textbox', { name: '搜索日志' })
    const before = await search.boundingBox()
    await expect.poll(() => grid.evaluate((e) => e.clientHeight)).toBeGreaterThan(80)
    expect(await grid.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
    expect(await grid.getByRole('row').count()).toBeLessThan(50)
    await grid.evaluate((e) => {
      e.scrollTop = 0
    })
    await expect.poll(() => grid.evaluate((e) => e.scrollTop)).toBe(0)
    expect(await search.boundingBox()).toEqual(before)
    await expect(page.getByRole('button', { name: '导出', exact: true })).toBeInViewport()
    expect(
      await page.locator('html').evaluate((e) => e.scrollWidth <= innerWidth && e.scrollHeight <= innerHeight),
    ).toBe(true)
    expect(await grid.getByRole('gridcell').first().textContent()).not.toMatch(/。$/u)
    await page.getByRole('button', { name: '更多筛选', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '智能体', exact: true })).toBeVisible()
    if (size.width >= 1100) expect(await grid.evaluate((e) => e.clientHeight)).toBeGreaterThan(40)
    if (size.width < 1100)
      await page.getByRole('dialog', { name: '筛选日志' }).getByRole('button', { name: '关闭', exact: true }).click()
    else await page.getByRole('button', { name: '更多筛选', exact: true }).click()
    await mkdir(path.resolve('.local/logs-visual'), { recursive: true })
    await page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some(
            (animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
          ),
    )
    await page.screenshot({ path: path.resolve(`.local/logs-visual/fullscreen-${size.width}.png`) })
  }
  expect(errors).toEqual([])
})
