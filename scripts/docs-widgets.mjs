// The documentation widgets' runtime and images (docs/site/BUNDLE.md).
//   node scripts/docs-widgets.mjs [--shots .local/docs-shots]
// Renders every widget's still images (light and dark) and, for animated ones, a GIF into <shots>/widgets, with
// widgets.json saying what was rendered. Runs after the flows, since a 截图导览 shows a flow's shot; `pnpm docs:shots`
// runs both. scripts/docs-bundle.mjs publishes the images with the same runtime.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWidget, widgetAnimates, widgetPosters } from '../docs/site/widgets/spec.mjs'
import { readSite } from './docs-bundle.mjs'
import { buildWidgetRuntime, WIDGETS_DIR } from './lib/docs-widget-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://docs-widgets.invalid'
const THEMES = ['light', 'dark']
// The width of the docs column on the site, so still images match what readers see there.
const POSTER_WIDTH = 720
const GIF_WIDTH = POSTER_WIDTH
const GIF_SCALE = 1.25
const GIF_FRAME_MS = 100
const GIF_BACKGROUND = '#fffefb'

/** Shots the flows took, as a tour resolves them: served from the harness origin, with their marks. */
async function flowShots(shotsDir) {
  const shots = new Map()
  for (const file of existsSync(shotsDir) ? await readdir(shotsDir) : []) {
    if (!file.endsWith('.json')) continue
    const report = JSON.parse(await readFile(path.join(shotsDir, file), 'utf8'))
    if (report.status !== 'passed' || typeof report.shots !== 'object') continue
    for (const [name, shot] of Object.entries(report.shots))
      if (THEMES.every((theme) => existsSync(path.join(shotsDir, `${name}.${theme}.webp`))))
        shots.set(name, {
          light: `${ORIGIN}/shots/${name}.light.webp`,
          dark: `${ORIGIN}/shots/${name}.dark.webp`,
          width: shot.width,
          height: shot.height,
          marks: shot.marks,
        })
  }
  return shots
}

const harness = (width, background) => `<!doctype html>
<meta charset="utf-8">
<style>html, body { margin: 0; background: ${background}; } #host { width: ${width}px; }</style>
<div id="host"></div>
<script type="module">
  import { mount, animationLength } from '/runtime.js'
  let unmount = () => {}
  window.showWidget = async (widget, poster) => {
    unmount()
    unmount = mount(document.getElementById('host'), widget, poster)
    const root = document.getElementById('host').shadowRoot
    await Promise.all([...root.querySelectorAll('img')].map((img) =>
      img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve })))
    await document.fonts.ready
    // Flows measure their boxes after the first render and draw the arrows on the next.
    for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  window.animationLength = animationLength
  window.harnessReady = true
</script>`

async function openHarness(browser, runtime, shotsDir, { width, scale, background }) {
  const context = await browser.newContext({
    viewport: { width: width + 40, height: 900 },
    deviceScaleFactor: scale,
    locale: 'zh-CN',
    reducedMotion: 'no-preference',
  })
  const page = await context.newPage()
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: harness(width, background) })
    if (pathname === '/runtime.js') return route.fulfill({ contentType: 'text/javascript', body: runtime })
    const shot = pathname.match(/^\/shots\/([a-z0-9-]+\.(?:light|dark)\.webp)$/u)?.[1]
    if (shot !== undefined && existsSync(path.join(shotsDir, shot)))
      return route.fulfill({ contentType: 'image/webp', body: readFileSync(path.join(shotsDir, shot)) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => /** @type {any} */ (globalThis).harnessReady === true)
  return { context, page }
}

const show = (page, widget, poster) =>
  page.evaluate(([value, still]) => /** @type {any} */ (globalThis).showWidget(value, still), [widget, poster])

async function renderWidget(widget, resolved, { stills, gifs }, outDir, sharp) {
  const posters = {}
  for (const theme of THEMES) {
    await stills.page.emulateMedia({ colorScheme: theme })
    for (const { state } of widgetPosters(widget)) {
      // Long after the end of any animation: the finished picture.
      await show(stills.page, resolved, { state, time: 1e9 })
      const host = stills.page.locator('#host')
      const box = await host.boundingBox()
      if (box === null) throw new Error('组件没有显示出来')
      await sharp(await host.screenshot({ animations: 'disabled', omitBackground: true }))
        .webp({ quality: 88 })
        .toFile(path.join(outDir, `${widget.id}.${state}.${theme}.webp`))
      posters[state] = { width: Math.round(box.width), height: Math.round(box.height) }
    }
  }
  if (!widgetAnimates(widget)) return { status: 'passed', posters }
  // Sent into chats, where light is the safe default; every frame is cut to the same box.
  const total = await gifs.page.evaluate((value) => /** @type {any} */ (globalThis).animationLength(value), resolved)
  await show(gifs.page, resolved, { state: 'overview', time: total })
  const box = await gifs.page.locator('#host').boundingBox()
  if (box === null) throw new Error('组件没有显示出来')
  // Tall enough for its tallest state, since a chat changes height between modes.
  const clip = { ...box, height: Math.max(box.height, ...Object.values(posters).map((poster) => poster.height)) }
  const frames = []
  for (let time = 0; time <= total; time += GIF_FRAME_MS) {
    await show(gifs.page, resolved, { state: 'overview', time })
    frames.push(await gifs.page.screenshot({ clip, animations: 'disabled' }))
  }
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: frames.map(() => GIF_FRAME_MS), loop: 0, effort: 7 })
    .toFile(path.join(outDir, `${widget.id}.animation.gif`))
  return {
    status: 'passed',
    posters,
    animation: { width: Math.round(clip.width * GIF_SCALE), height: Math.round(clip.height * GIF_SCALE) },
  }
}

async function main() {
  const index = process.argv.indexOf('--shots')
  const shotsDir = path.resolve(repositoryRoot, index >= 0 ? process.argv[index + 1] : '.local/docs-shots')
  const outDir = path.join(shotsDir, WIDGETS_DIR)
  await mkdir(outDir, { recursive: true })
  const { chromium } = await import('@playwright/test')
  const { default: sharp } = await import('sharp')
  const site = await readSite()
  if (site.errors.length > 0) throw new Error(site.errors.join('\n'))
  const widgets = [...site.pages.values()].flatMap((page) => page.widgets)
  const shots = await flowShots(shotsDir)
  const runtime = await buildWidgetRuntime()
  const browser = await chromium.launch()
  const report = { widgets: {} }
  try {
    const stills = await openHarness(browser, runtime, shotsDir, {
      width: POSTER_WIDTH,
      scale: 2,
      background: 'transparent',
    })
    const gifs = await openHarness(browser, runtime, shotsDir, {
      width: GIF_WIDTH,
      scale: GIF_SCALE,
      background: GIF_BACKGROUND,
    })
    for (const widget of widgets) {
      try {
        const resolved = resolveWidget(widget, (name) => shots.get(name))
        report.widgets[widget.id] = await renderWidget(widget, resolved, { stills, gifs }, outDir, sharp)
        console.log(`  ✓ ${widget.id}`)
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
        report.widgets[widget.id] = { status: 'failed', error: message }
        console.log(`  ✗ ${widget.id}：${message}`)
      }
    }
  } finally {
    await browser.close()
  }
  await writeFile(path.join(outDir, 'widgets.json'), `${JSON.stringify(report, null, 2)}\n`)
  const failed = Object.values(report.widgets).filter((entry) => entry.status !== 'passed').length
  console.log(
    `文档组件：${widgets.length - failed}/${widgets.length} 个出图 → ${path.relative(repositoryRoot, outDir)}`,
  )
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
