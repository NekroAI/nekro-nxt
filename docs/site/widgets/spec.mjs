// Documentation widgets: interactive pieces a page embeds as a ```nxt:<kind> code block with YAML inside. Each one is
// data that becomes four things: the interactive version on the site (runtime/), a text version for agents and search
// (describe), still images of its key states and, for animated ones, a GIF (scripts/docs-widgets.mjs).
// Format and rules: docs/site/BUNDLE.md.
import { createRequire } from 'node:module'

// Loaded on first use: uploading a built bundle reads this module but parses no YAML, and runs without dependencies.
const require = createRequire(import.meta.url)
const parseYaml = (source) => require('yaml').parse(source)

export const WIDGET_FENCE = /^```nxt:([a-z-]+)\s*$/u
/** What a widget block becomes in the bundle's markdown: the site and the text version look it up by id. */
export const BUNDLE_FENCE = 'nxt-widget'
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const TONES = new Set(['positive', 'neutral', 'negative'])
const MAX_STEPS = 8

class WidgetError extends Error {}

const fail = (message) => {
  throw new WidgetError(message)
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value, where, { optional = false, max = 200 } = {}) => {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} 要写一段文字`)
  if (value.length > max) fail(`${where} 太长（最多 ${max} 字）`)
  return value.trim()
}

const id = (value, where) => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${where} 要用小写字母、数字和 -`)
  return value
}

const list = (value, where, { min = 1, max = 12 } = {}) => {
  if (!Array.isArray(value) || value.length < min) fail(`${where} 至少要有 ${min} 项`)
  if (value.length > max) fail(`${where} 最多 ${max} 项`)
  return value
}

const only = (record, keys, where) => {
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${where} 不认识的字段 ${key}`)
}

/** A screenshot with numbered spots on the parts a reader touches, one step each. */
const tour = (raw) => {
  only(raw, ['id', 'title', 'shot', 'steps'], '截图导览')
  return {
    shot: id(raw.shot, 'shot（截图名）'),
    steps: list(raw.steps, 'steps', { max: MAX_STEPS }).map((step, index) => {
      const where = `第 ${index + 1} 步`
      if (!isRecord(step)) fail(`${where} 要写 mark 和 text`)
      only(step, ['mark', 'text'], where)
      return { mark: id(step.mark, `${where} 的 mark`), text: text(step.text, `${where} 的 text`) }
    }),
  }
}

const diagramNodes = (raw) => {
  const nodes = list(raw, 'nodes', { max: 12 }).map((node, index) => {
    const where = `第 ${index + 1} 个节点`
    if (!isRecord(node)) fail(`${where} 要写 id 和 label`)
    only(node, ['id', 'label', 'note', 'at'], where)
    const at = node.at
    if (
      at !== undefined &&
      !(
        Array.isArray(at) &&
        at.length === 2 &&
        Number.isInteger(at[0]) &&
        Number.isInteger(at[1]) &&
        at[0] >= 0 &&
        at[0] < 4 &&
        at[1] >= 0 &&
        at[1] < 6
      )
    )
      // Four columns is what still fits a phone.
      fail(`${where} 的 at 要写成 [列, 行]，列是 0–3，行是 0–5`)
    return {
      id: id(node.id, `${where} 的 id`),
      label: text(node.label, `${where} 的 label`, { max: 16 }),
      ...(node.note === undefined ? {} : { note: text(node.note, `${where} 的 note`, { max: 40 }) }),
      ...(at === undefined ? {} : { at }),
    }
  })
  const ids = new Set()
  for (const node of nodes) {
    if (ids.has(node.id)) fail(`节点 ${node.id} 重复`)
    ids.add(node.id)
  }
  const placed = nodes.filter((node) => node.at !== undefined).length
  if (placed !== 0 && placed !== nodes.length) fail('节点的 at 要么都写，要么都不写')
  const cells = new Set(nodes.flatMap((node) => (node.at === undefined ? [] : [node.at.join(',')])))
  if (cells.size !== placed) fail('有两个节点放在了同一格')
  return nodes
}

/**
 * A diagram in one of three fixed shapes, so every figure in the docs looks alike: `flow` (boxes and arrows, a chain
 * unless placed on a grid; `animate` sends a dot along the arrows in order), `layers` (stacked from top to bottom) and
 * `compare` (columns side by side).
 */
const diagram = (raw) => {
  const type = raw.type
  if (type === 'flow') {
    only(raw, ['id', 'title', 'type', 'nodes', 'edges', 'animate'], '图解')
    const nodes = diagramNodes(raw.nodes)
    const known = new Set(nodes.map((node) => node.id))
    const edges =
      raw.edges === undefined
        ? nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
        : list(raw.edges, 'edges', { max: 16 }).map((edge, index) => {
            const where = `第 ${index + 1} 条连线`
            if (!isRecord(edge)) fail(`${where} 要写 from 和 to`)
            only(edge, ['from', 'to', 'label'], where)
            for (const end of [edge.from, edge.to])
              if (!known.has(end)) fail(`${where} 连到了不存在的节点 ${String(end)}`)
            return {
              from: edge.from,
              to: edge.to,
              ...(edge.label === undefined ? {} : { label: text(edge.label, `${where} 的 label`, { max: 16 }) }),
            }
          })
    if (raw.animate !== undefined && typeof raw.animate !== 'boolean') fail('animate 只能是 true 或 false')
    return { type, nodes, edges, animate: raw.animate === true }
  }
  if (type === 'layers') {
    only(raw, ['id', 'title', 'type', 'layers'], '图解')
    return {
      type,
      layers: list(raw.layers, 'layers', { min: 2, max: 6 }).map((layer, index) => {
        const where = `第 ${index + 1} 层`
        if (!isRecord(layer)) fail(`${where} 要写 label`)
        only(layer, ['label', 'note', 'items'], where)
        return {
          label: text(layer.label, `${where} 的 label`, { max: 16 }),
          ...(layer.note === undefined ? {} : { note: text(layer.note, `${where} 的 note`, { max: 60 }) }),
          items:
            layer.items === undefined
              ? []
              : list(layer.items, `${where} 的 items`, { max: 8 }).map((item, position) =>
                  text(item, `${where} 第 ${position + 1} 项`, { max: 16 }),
                ),
        }
      }),
    }
  }
  if (type === 'compare') {
    only(raw, ['id', 'title', 'type', 'columns'], '图解')
    return {
      type,
      columns: list(raw.columns, 'columns', { min: 2, max: 4 }).map((column, index) => {
        const where = `第 ${index + 1} 列`
        if (!isRecord(column)) fail(`${where} 要写 title 和 points`)
        only(column, ['title', 'tone', 'points'], where)
        if (column.tone !== undefined && !TONES.has(column.tone))
          fail(`${where} 的 tone 只能是 positive、neutral 或 negative`)
        return {
          title: text(column.title, `${where} 的 title`, { max: 16 }),
          tone: column.tone ?? 'neutral',
          points: list(column.points, `${where} 的 points`, { max: 6 }).map((point, position) =>
            text(point, `${where} 第 ${position + 1} 点`, { max: 40 }),
          ),
        }
      }),
    }
  }
  return fail('图解的 type 只能是 flow、layers 或 compare')
}

const KINDS = { tour, diagram }

/** The widget blocks of a page's markdown, validated; throws with the line of the block in the message. */
export function parseWidget(kind, source, where) {
  try {
    if (!(kind in KINDS)) fail(`没有 nxt:${kind} 这种组件，能用的有 ${Object.keys(KINDS).join('、')}`)
    let raw
    try {
      raw = parseYaml(source)
    } catch (error) {
      fail(`YAML 写错了：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
    if (!isRecord(raw)) fail('内容要写成 YAML 的 键: 值')
    return { id: id(raw.id, 'id'), kind, title: text(raw.title, 'title', { max: 30 }), data: KINDS[kind](raw) }
  } catch (error) {
    if (error instanceof WidgetError) throw new Error(`${where}：${error.message}`)
    throw error
  }
}

const label = (nodes) => new Map(nodes.map((node) => [node.id, node.label]))

/**
 * The text version: what an agent reads in place of the widget and what search indexes. It says what kind of picture
 * it is and everything the picture shows, so an agent can answer from it, or walk someone through it, without seeing it.
 */
export function describeWidget(widget) {
  const { kind, title, data } = widget
  if (kind === 'tour')
    return [
      `截图导览「${title}」：界面截图上按顺序标了 ${data.steps.length} 处。`,
      ...data.steps.map((step, index) => `${index + 1}. ${step.text}`),
    ].join('\n')
  if (data.type === 'flow') {
    const names = label(data.nodes)
    const lines = [`图解「${title}」：${data.animate ? '动画演示' : '流程图'}，${data.nodes.length} 个环节。`]
    for (const node of data.nodes) lines.push(`- ${node.label}${node.note === undefined ? '' : `：${node.note}`}`)
    lines.push(
      `连线：${data.edges.map((edge) => `${names.get(edge.from)} → ${names.get(edge.to)}${edge.label === undefined ? '' : `（${edge.label}）`}`).join('；')}`,
    )
    return lines.join('\n')
  }
  if (data.type === 'layers')
    return [
      `图解「${title}」：分层图，从上到下 ${data.layers.length} 层。`,
      ...data.layers.map(
        (layer, index) =>
          `${index + 1}. ${layer.label}${layer.note === undefined ? '' : `：${layer.note}`}${layer.items.length === 0 ? '' : `（${layer.items.join('、')}）`}`,
      ),
    ].join('\n')
  return [
    `图解「${title}」：对照图，${data.columns.length} 列并排。`,
    ...data.columns.map((column) => `- ${column.title}：${column.points.join('；')}`),
  ].join('\n')
}

/**
 * The still images a widget has, by state, each with what it shows; agents pick one by name to send. `overview` is
 * the one the site shows before the widget starts and the one external readers get.
 */
export function widgetPosters(widget) {
  if (widget.kind === 'tour')
    return [
      { state: 'overview', label: `${widget.title}：全部 ${widget.data.steps.length} 步` },
      ...widget.data.steps.map((step, index) => ({ state: `step-${index + 1}`, label: `第 ${index + 1} 步：${step.text}` })),
    ]
  return [{ state: 'overview', label: widget.title }]
}

export const widgetAnimates = (widget) => widget.kind === 'diagram' && widget.data.type === 'flow' && widget.data.animate

/**
 * Replaces each widget block of a page with the bundle's ```nxt-widget block holding just its id. Returns the new
 * lines and the widgets; problems go to `errors` so one bad block does not hide the others.
 */
export function extractWidgets(lines, file, errors) {
  const out = []
  const widgets = []
  for (let index = 0; index < lines.length; index += 1) {
    const kind = lines[index].match(WIDGET_FENCE)?.[1]
    if (kind === undefined) {
      out.push(lines[index])
      continue
    }
    const end = lines.findIndex((line, position) => position > index && /^```\s*$/u.test(line))
    if (end < 0) {
      errors.push(`${file} 第 ${index + 1} 行：nxt:${kind} 组件没有结束的 \`\`\``)
      out.push(...lines.slice(index))
      break
    }
    try {
      const widget = parseWidget(kind, lines.slice(index + 1, end).join('\n'), `${file} 第 ${index + 1} 行`)
      widgets.push(widget)
      out.push(`\`\`\`${BUNDLE_FENCE}`, widget.id, '```')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    index = end
  }
  return { lines: out, widgets }
}

/**
 * The widget as the runtime takes it: a tour's shot becomes its images and each step's mark becomes a box on it.
 * `shotOf(name)` gives `{ light, dark, width, height, marks }` or undefined; throws when the shot or a mark is missing.
 */
export function resolveWidget(widget, shotOf) {
  if (widget.kind !== 'tour') return { id: widget.id, kind: widget.kind, title: widget.title, data: widget.data }
  const shot = shotOf(widget.data.shot)
  if (shot === undefined) throw new Error(`截图导览 ${widget.id} 用的截图 ${widget.data.shot} 没有生成`)
  const missing = widget.data.steps.filter((step) => shot.marks?.[step.mark] === undefined).map((step) => step.mark)
  if (missing.length > 0)
    throw new Error(`截图导览 ${widget.id}：截图 ${widget.data.shot} 没有标注 ${missing.join('、')}（流程里 docs.shot 的 marks）`)
  return {
    id: widget.id,
    kind: widget.kind,
    title: widget.title,
    data: {
      shot: { light: shot.light, dark: shot.dark, width: shot.width, height: shot.height },
      steps: widget.data.steps.map((step) => ({ text: step.text, box: shot.marks[step.mark] })),
    },
  }
}
