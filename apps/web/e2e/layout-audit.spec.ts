import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import {
  installLargeWorkspaceRoutes,
  largeAgentIds,
  largeChannelIds,
  largeConnectionIds,
  largeSnapshot,
  largeTaskId,
} from './fixtures/large-workspace.js'

/**
 * Layout audit (Decision 2026-10-06 §9). Visits every space and key sub-page with realistic-volume fictional data
 * at four desktop widths in both themes, and records layout defects that screenshots at one size miss.
 * Report mode by default; NEKRO_LAYOUT_AUDIT_STRICT=1 turns findings into failures.
 */

const strict = Boolean(process.env['NEKRO_LAYOUT_AUDIT_STRICT'])
const reportDirectory = path.resolve(process.cwd(), '.local/layout-audit')

const PAGES = [
  { name: '现场', path: '/live' },
  { name: '频道（长名称）', path: `/channels/${largeChannelIds[1]}` },
  { name: '频道（内置）', path: `/channels/${largeChannelIds[0]}` },
  { name: '智能体（长设定）', path: `/agents/${largeAgentIds[0]}` },
  { name: '智能体（英文长名）', path: `/agents/${largeAgentIds[1]}` },
  { name: '工坊任务', path: `/workshop/tasks/${largeTaskId}` },
  { name: '工坊扩展', path: `/workshop/extensions/${largeSnapshot.extensions[0]?.id ?? ''}` },
  { name: '接线账号', path: `/wiring/connections/${largeConnectionIds.healthy}` },
  { name: '接线异常账号', path: `/wiring/connections/${largeConnectionIds.failing}` },
  { name: '接线频道', path: `/wiring/channels/${largeChannelIds[2]}` },
  { name: '添加账号', path: '/wiring/new?adapter=fixture-beta' },
  { name: '设置·模型', path: '/settings/models' },
  { name: '设置·平台适配器', path: '/settings/adapters' },
  { name: '设置·DSH 插件', path: '/settings/dsh' },
  { name: '设置·通知', path: '/settings/notifications' },
  { name: '设置·外观', path: '/settings/appearance' },
  { name: '设置·关于', path: '/settings/about' },
] as const

const WIDTHS = [1100, 1280, 1440, 1920] as const
const THEMES = ['light', 'dark'] as const

/** Ordered by how badly each defect breaks the page. */
const SEVERITY = {
  'page-overflow': 6,
  clipped: 5,
  covered: 4,
  'blank-canvas': 4,
  'container-overflow': 3,
  truncated: 2,
  'small-target': 1,
} as const
type Kind = keyof typeof SEVERITY
const KINDS: readonly Kind[] = [
  'page-overflow',
  'clipped',
  'covered',
  'blank-canvas',
  'container-overflow',
  'truncated',
  'small-target',
]
const isKind = (value: string): value is Kind => KINDS.some((kind) => kind === value)

interface Issue {
  readonly page: string
  readonly width: number
  readonly theme: string
  readonly kind: Kind
  readonly element: string
  readonly detail: string
}

const allIssues: Issue[] = []

/** Runs inside the page: returns every defect on the current screen. */
const auditScreen = (page: Page) =>
  page.evaluate(() => {
    const found: { kind: string; element: string; detail: string }[] = []
    const describe = (element: Element): string => {
      const text = element instanceof HTMLElement ? element.innerText : ''
      const label =
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        (text || element.textContent || '').trim().replace(/\s+/gu, ' ').slice(0, 40)
      const role = element.getAttribute('role')
      const name = [...element.classList].find((item) => !/^_/u.test(item))?.replace(/_[a-z0-9]{5,}$/iu, '') ?? ''
      return `${element.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${name ? `.${name}` : ''}${label ? ` “${label}”` : ''}`
    }
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
      return !element.closest('[inert], [hidden], [aria-hidden="true"]')
    }
    const horizontalScrollAllowed = (element: Element) =>
      element.matches('pre, code, textarea, [data-scroll-x], [data-scroll-x] *') || element.closest('pre') !== null

    // Page-level horizontal overflow.
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth + 1)
      found.push({
        kind: 'page-overflow',
        element: 'html',
        detail: `内容宽 ${root.scrollWidth}px，视口 ${root.clientWidth}px`,
      })

    const elements = [...document.querySelectorAll('body *')].filter(visible)
    const viewport = { width: window.innerWidth, height: window.innerHeight }

    for (const element of elements) {
      const html = element
      const style = getComputedStyle(element)
      const overflowX = style.overflowX
      const horizontallyOverflowing = html.scrollWidth > html.clientWidth + 1 && html.clientWidth > 0

      // A scrollable container that scrolls sideways although it is not meant to.
      if (horizontallyOverflowing && ['auto', 'scroll'].includes(overflowX) && !horizontalScrollAllowed(element))
        found.push({
          kind: 'container-overflow',
          element: describe(element),
          detail: `横向滚动 ${html.scrollWidth - html.clientWidth}px`,
        })

      // Text cut by its own box without an ellipsis or line clamp.
      const ownText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim(),
      )
      if (
        ownText &&
        horizontallyOverflowing &&
        ['hidden', 'clip'].includes(overflowX) &&
        style.textOverflow !== 'ellipsis' &&
        style.getPropertyValue('-webkit-line-clamp') === 'none'
      )
        found.push({ kind: 'truncated', element: describe(element), detail: '文字被截断且没有省略号' })
    }

    // Leaf content pushed outside a clipping ancestor (e.g. table columns cut off at a panel edge).
    const leaves = elements.filter(
      (element) =>
        element.matches('button, a[href], input, select, textarea, [role="switch"], th, td, label') ||
        [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()),
    )
    for (const element of leaves) {
      const rect = element.getBoundingClientRect()
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent)
        if (!['hidden', 'clip'].includes(parentStyle.overflowX)) continue
        const box = parent.getBoundingClientRect()
        if (rect.right > box.right + 2 && rect.left < box.right && !horizontalScrollAllowed(element)) {
          const ellipsis = getComputedStyle(element).textOverflow === 'ellipsis'
          if (!ellipsis)
            found.push({
              kind: 'clipped',
              element: describe(element),
              detail: `超出容器 ${describe(parent)} 右缘 ${Math.round(rect.right - box.right)}px`,
            })
        }
        break
      }
    }

    // Interactive elements: size and whether something else sits on top of them.
    const interactive = elements.filter((element) =>
      element.matches(
        'button, a[href], input:not([type="hidden"]):not([type="file"]), select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"]',
      ),
    )
    for (const element of interactive) {
      const rect = element.getBoundingClientRect()
      const inlineLink =
        element.tagName === 'A' &&
        getComputedStyle(element).display === 'inline' &&
        [...(element.parentElement?.childNodes ?? [])].some(
          (node) => node !== element && node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim(),
        )
      if (!inlineLink && (rect.width < 32 || rect.height < 32) && !element.closest('[role="option"]'))
        found.push({
          kind: 'small-target',
          element: describe(element),
          detail: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
        })
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) continue
      // Only judge points the user can actually see: inside every clipping or scrolling ancestor.
      let reachable = true
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent)
        if (parentStyle.overflowX === 'visible' && parentStyle.overflowY === 'visible') continue
        const box = parent.getBoundingClientRect()
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
          reachable = false
          break
        }
      }
      if (!reachable) continue
      const top = document.elementFromPoint(x, y)
      if (top && top !== element && !element.contains(top) && !top.contains(element))
        found.push({ kind: 'covered', element: describe(element), detail: `被 ${describe(top)} 覆盖` })
    }

    // Blank canvas: the space rendered nothing readable.
    const canvas = document.querySelector('main [data-canvas]') ?? document.querySelector('main')
    if (!canvas || !(canvas.textContent ?? '').trim())
      found.push({ kind: 'blank-canvas', element: 'main', detail: '主画布没有任何内容' })

    return found
  })

const settle = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('main')?.textContent ?? '').trim().length > 0, null, {
    timeout: 8_000,
  })
  await page.evaluate(() => document.fonts.ready)
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity,
          ),
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined)
  await page.waitForTimeout(250)
}

test.describe.configure({ mode: 'serial' })

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`layout audit · ${width}px · ${theme === 'light' ? '浅色' : '深色'}`, async ({ browser }, testInfo) => {
      test.setTimeout(240_000)
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme })
      await context.addInitScript((value) => window.localStorage.setItem('nekro-nxt.theme', value), theme)
      const page = await context.newPage()
      await installSnapshotHealthRoutes(page, largeSnapshot)
      await installLargeWorkspaceRoutes(page)
      const issues: Issue[] = []
      for (const target of PAGES) {
        await page.goto(target.path)
        try {
          await settle(page)
        } catch {
          // A page that never shows content is itself a finding; the audit below records it as a blank canvas.
        }
        for (const found of await auditScreen(page)) {
          if (!isKind(found.kind)) continue
          issues.push({
            page: target.name,
            width,
            theme,
            kind: found.kind,
            element: found.element,
            detail: found.detail,
          })
        }
      }
      await context.close()

      const unique = issues.filter(
        (issue, index) =>
          issues.findIndex(
            (other) => other.page === issue.page && other.kind === issue.kind && other.element === issue.element,
          ) === index,
      )
      allIssues.push(...unique)
      await testInfo.attach(`layout-${width}-${theme}.json`, {
        body: JSON.stringify(unique, null, 2),
        contentType: 'application/json',
      })
      for (const kind of KINDS) {
        const count = unique.filter((issue) => issue.kind === kind).length
        if (count) testInfo.annotations.push({ type: `layout:${kind}`, description: `${count} 处` })
      }
      if (strict)
        expect(
          unique,
          unique.map((issue) => `${issue.page} ${issue.kind} ${issue.element} ${issue.detail}`).join('\n'),
        ).toEqual([])
    })
  }
}

test.afterAll(async () => {
  if (allIssues.length === 0 && !strict) return
  await mkdir(reportDirectory, { recursive: true })
  // Rank defect groups by severity, then by how many elements, sizes and themes show them. A group is one page, one
  // kind and one element class (for clipping: one clipping container), so forty clipped switches read as one problem.
  const withoutLabel = (text: string) => text.replace(/ “[^”]*”/gu, '').replace(/ \d+px$/u, '')
  const groupOf = (issue: Issue) =>
    issue.kind === 'clipped'
      ? withoutLabel(issue.detail)
      : issue.kind === 'small-target'
        ? withoutLabel(issue.element)
        : issue.element
  const grouped = new Map<string, { issue: Issue; occurrences: number; sizes: Set<string>; elements: Set<string> }>()
  for (const issue of allIssues) {
    const key = `${issue.page}\0${issue.kind}\0${groupOf(issue)}`
    const entry = grouped.get(key) ?? { issue, occurrences: 0, sizes: new Set<string>(), elements: new Set<string>() }
    entry.occurrences += 1
    entry.elements.add(issue.element)
    entry.sizes.add(`${issue.width}/${issue.theme === 'light' ? '浅' : '深'}`)
    grouped.set(key, entry)
  }
  const ranked = [...grouped.values()].sort(
    (left, right) =>
      SEVERITY[right.issue.kind] - SEVERITY[left.issue.kind] ||
      right.elements.size - left.elements.size ||
      right.occurrences - left.occurrences,
  )
  const pages = [...new Set(allIssues.map((issue) => issue.page))]
  const kinds = KINDS
  const table = [
    `| 页面 | ${kinds.join(' | ')} |`,
    `|---|${kinds.map(() => '---').join('|')}|`,
    ...pages.map(
      (name) =>
        `| ${name} | ${kinds.map((kind) => new Set(allIssues.filter((issue) => issue.page === name && issue.kind === kind).map((issue) => issue.element)).size).join(' | ')} |`,
    ),
  ]
  const summary = [
    '# 布局审计报告',
    '',
    `共 ${grouped.size} 组问题（${allIssues.length} 次出现，${WIDTHS.length} 个宽度 × 明暗两种主题）。表格按页面统计不同元素数。`,
    '',
    ...table,
    '',
    '## 最严重的问题',
    '',
    ...ranked
      .slice(0, 20)
      .map(
        ({ issue, sizes, elements }, index) =>
          `${index + 1}. [${issue.kind}] ${issue.page} · ${elements.size > 1 ? `${elements.size} 个元素，例如 ` : ''}${issue.element} — ${issue.detail}（${[...sizes].join('、')}）`,
      ),
  ].join('\n')
  await writeFile(path.join(reportDirectory, 'summary.md'), `${summary}\n`)
  await writeFile(path.join(reportDirectory, 'issues.json'), JSON.stringify(allIssues, null, 2))
})
