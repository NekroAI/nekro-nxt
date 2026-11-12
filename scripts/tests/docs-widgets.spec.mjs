import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  describeWidget,
  extractWidgets,
  parseWidget,
  resolveWidget,
  widgetAnimates,
  widgetPosters,
} from '../../docs/site/widgets/spec.mjs'
import { applyWidgets, readSite } from '../docs-bundle.mjs'

const TOUR = `id: wiring-tour
title: 接线
shot: wiring
steps:
  - mark: add
    text: 点「添加平台账号」。
  - mark: agents
    text: 拖到「智能体」。`

const FLOW = `id: message-path
title: 消息怎么变成回复
type: flow
animate: true
nodes:
  - id: member
    label: 群友发言
  - id: account
    label: 平台账号
    note: 收到消息
edges:
  - from: member
    to: account
    label: 发到群里`

test('widget blocks are validated with the line they start on', () => {
  assert.equal(parseWidget('tour', TOUR, 'a.md').data.steps.length, 2)
  const bad = (kind, source) =>
    assert.throws(() => parseWidget(kind, source, 'a.md 第 3 行'), /^Error: a\.md 第 3 行：/u)
  bad('chart', 'id: x\ntitle: y')
  bad('tour', 'id: x\ntitle: y\nshot: s\nsteps: []')
  bad('tour', 'id: X\ntitle: y\nshot: s\nsteps: [{ mark: a, text: b }]')
  bad('tour', 'id: x\ntitle: y\nshot: s\nsteps: [{ mark: a, text: b, extra: 1 }]')
  bad('diagram', 'id: x\ntitle: y\ntype: pie')
  bad('diagram', 'id: x\ntitle: y\ntype: flow\nnodes: [{ id: a, label: A }]\nedges: [{ from: a, to: b }]')
  bad('diagram', 'id: x\ntitle: y\ntype: flow\nnodes: [{ id: a, label: A, at: [0, 0] }, { id: b, label: B }]')
  bad(
    'diagram',
    'id: x\ntitle: y\ntype: flow\nnodes: [{ id: a, label: A, at: [0, 0] }, { id: b, label: B, at: [0, 0] }]',
  )
  bad('diagram', 'id: x\ntitle: y\ntype: compare\ncolumns: [{ title: a, points: [b] }]')
  bad('diagram', 'title: [unclosed')
})

test('a flow without edges is a chain in node order', () => {
  const widget = parseWidget(
    'diagram',
    'id: x\ntitle: y\ntype: flow\nnodes: [{ id: a, label: A }, { id: b, label: B }, { id: c, label: C }]',
    '',
  )
  assert.deepEqual(widget.data.edges, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ])
  assert.equal(widgetAnimates(widget), false)
})

test('the text version says what kind of picture it is and everything on it', () => {
  assert.equal(
    describeWidget(parseWidget('tour', TOUR, '')),
    '截图导览「接线」：界面截图上按顺序标了 2 处。\n1. 点「添加平台账号」。\n2. 拖到「智能体」。',
  )
  assert.equal(
    describeWidget(parseWidget('diagram', FLOW, '')),
    '图解「消息怎么变成回复」：动画演示，2 个环节。\n- 群友发言\n- 平台账号：收到消息\n连线：群友发言 → 平台账号（发到群里）',
  )
  const layers = parseWidget(
    'diagram',
    'id: x\ntitle: 两层\ntype: layers\nlayers: [{ label: 上, note: 说明, items: [甲, 乙] }, { label: 下 }]',
    '',
  )
  assert.equal(describeWidget(layers), '图解「两层」：分层图，从上到下 2 层。\n1. 上：说明（甲、乙）\n2. 下')
  const compare = parseWidget(
    'diagram',
    'id: x\ntitle: 对照\ntype: compare\ncolumns: [{ title: 甲, tone: positive, points: [快, 省] }, { title: 乙, points: [慢] }]',
    '',
  )
  assert.equal(describeWidget(compare), '图解「对照」：对照图，2 列并排。\n- 甲：快；省\n- 乙：慢')
})

test('a tour has an overview and one image per step, each saying what it shows', () => {
  assert.deepEqual(widgetPosters(parseWidget('tour', TOUR, '')), [
    { state: 'overview', label: '接线：全部 2 步' },
    { state: 'step-1', label: '第 1 步：点「添加平台账号」。' },
    { state: 'step-2', label: '第 2 步：拖到「智能体」。' },
  ])
})

test('widget blocks become id blocks in the bundle and errors keep the other blocks', () => {
  const errors = []
  const { lines, widgets } = extractWidgets(
    ['前文', '```nxt:tour', ...TOUR.split('\n'), '```', '```nxt:diagram', 'id: x', '```', '```ts', 'code', '```'],
    'a.md',
    errors,
  )
  assert.deepEqual(lines, ['前文', '```nxt-widget', 'wiring-tour', '```', '```ts', 'code', '```'])
  assert.deepEqual(
    widgets.map((widget) => widget.id),
    ['wiring-tour'],
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^a\.md 第 12 行：/u)
})

test('a tour resolves its marks against the shot and names the ones missing', () => {
  const widget = parseWidget('tour', TOUR, '')
  const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
  const shot = { light: 'l', dark: 'd', width: 800, height: 600, marks: { add: box, agents: box } }
  assert.deepEqual(resolveWidget(widget, () => shot).data.steps[1], { text: '拖到「智能体」。', box })
  assert.throws(() => resolveWidget(widget, () => ({ ...shot, marks: { add: box } })), /没有标注 agents/u)
  assert.throws(() => resolveWidget(widget, () => undefined), /没有生成/u)
})

test('rendered images go into the bundle; missing ones fall back to the previous bundle and are reported', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'docs-widgets-'))
  const flow = parseWidget('diagram', FLOW, '')
  const tour = parseWidget('tour', TOUR, '')
  const site = {
    assets: new Map(),
    pages: new Map([['a/page', { id: 'a/page', file: 'docs/site/a/page.md', widgets: [flow, tour] }]]),
  }
  for (const name of [
    'message-path.overview.light.webp',
    'message-path.overview.dark.webp',
    'message-path.animation.gif',
  ])
    await writeFile(path.join(dir, name), name)
  await writeFile(
    path.join(dir, 'widgets.json'),
    JSON.stringify({
      widgets: {
        'message-path': {
          status: 'passed',
          posters: { overview: { width: 720, height: 300 } },
          animation: { width: 900, height: 375 },
        },
        'wiring-tour': { status: 'failed', error: '超时' },
      },
    }),
  )
  const flows = { shots: {}, stale: new Map(), missing: [] }
  const previousTour = { kind: 'tour', title: '旧', page: 'a/page', text: '旧', data: {}, posters: {} }
  const widgets = applyWidgets(site, flows, dir, { 'wiring-tour': previousTour })

  assert.equal(widgets['message-path'].text, describeWidget(flow))
  assert.equal(widgets['message-path'].posters.overview.label, '消息怎么变成回复')
  assert.match(widgets['message-path'].animation.url, /\/assets\/[0-9a-f]{16}\.gif$/u)
  assert.equal(site.assets.size, 3)
  // The tour's shot is gone: its page is stale and it keeps the previous version.
  assert.deepEqual(widgets['wiring-tour'], previousTour)
  assert.match(flows.stale.get('a/page')[0], /wiring 没有生成/u)
})

test('the repository documentation has no widget problems and unique widget ids', async () => {
  const site = await readSite()
  assert.deepEqual(site.errors, [])
  const ids = [...site.pages.values()].flatMap((page) => page.widgets.map((widget) => widget.id))
  assert.equal(new Set(ids).size, ids.length)
})
