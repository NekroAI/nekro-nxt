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
const MAX_CHOICES = 4
const MAX_MESSAGES = 14

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

/**
 * 排查向导: questions with a few answers each, ending in what to do. Steps are listed flat and point at each other by
 * id; the first one is where it starts. Every step must be reachable and the questions must not loop back.
 */
const wizard = (raw) => {
  only(raw, ['id', 'title', 'steps'], '排查向导')
  const steps = list(raw.steps, 'steps', { min: 2, max: 16 }).map((step, index) => {
    const where = `第 ${index + 1} 步`
    if (!isRecord(step)) fail(`${where} 要写 id 和 ask 或 answer`)
    const stepId = id(step.id, `${where} 的 id`)
    if (step.ask !== undefined) {
      only(step, ['id', 'ask', 'choices'], `${where}（${stepId}）`)
      return {
        id: stepId,
        ask: text(step.ask, `${stepId} 的 ask`, { max: 60 }),
        choices: list(step.choices, `${stepId} 的 choices`, { min: 2, max: MAX_CHOICES }).map((choice, position) => {
          const at = `${stepId} 第 ${position + 1} 个选项`
          if (!isRecord(choice)) fail(`${at} 要写 label 和 next`)
          only(choice, ['label', 'next'], at)
          return { label: text(choice.label, `${at} 的 label`, { max: 20 }), next: id(choice.next, `${at} 的 next`) }
        }),
      }
    }
    only(step, ['id', 'answer', 'link'], `${where}（${stepId}）`)
    return {
      id: stepId,
      answer: text(step.answer, `${stepId} 的 answer`, { max: 160 }),
      ...(step.link === undefined ? {} : { link: text(step.link, `${stepId} 的 link`, { max: 120 }) }),
    }
  })
  const byId = new Map()
  for (const step of steps) {
    if (byId.has(step.id)) fail(`步骤 ${step.id} 重复`)
    byId.set(step.id, step)
  }
  for (const step of steps)
    for (const choice of step.choices ?? [])
      if (!byId.has(choice.next)) fail(`${step.id} 的选项「${choice.label}」指向不存在的步骤 ${choice.next}`)
  const seen = new Set()
  const walk = (stepId, path) => {
    if (path.includes(stepId)) fail(`步骤绕回去了：${[...path, stepId].join(' → ')}`)
    seen.add(stepId)
    for (const choice of byId.get(stepId).choices ?? []) walk(choice.next, [...path, stepId])
  }
  if (steps[0].ask === undefined) fail('第一步要是一个问题（ask）')
  walk(steps[0].id, [])
  const unused = steps.filter((step) => !seen.has(step.id)).map((step) => step.id)
  if (unused.length > 0) fail(`这些步骤走不到：${unused.join('、')}`)
  return { steps }
}

/**
 * 聊天回放: a made-up group chat played message by message. With `modes`, each message says which modes she answers it
 * in, so switching the mode shows which messages wake her; without, `reply` is her one answer.
 */
const chat = (raw) => {
  only(raw, ['id', 'title', 'agent', 'modes', 'messages'], '聊天回放')
  const modes =
    raw.modes === undefined
      ? []
      : list(raw.modes, 'modes', { min: 2, max: 4 }).map((mode, index) => {
          const where = `第 ${index + 1} 种方式`
          if (!isRecord(mode)) fail(`${where} 要写 id 和 label`)
          only(mode, ['id', 'label', 'note'], where)
          return {
            id: id(mode.id, `${where} 的 id`),
            label: text(mode.label, `${where} 的 label`, { max: 10 }),
            ...(mode.note === undefined ? {} : { note: text(mode.note, `${where} 的 note`, { max: 40 }) }),
          }
        })
  const modeIds = new Set(modes.map((mode) => mode.id))
  if (modeIds.size !== modes.length) fail('modes 里有重复的 id')
  const messages = list(raw.messages, 'messages', { max: MAX_MESSAGES }).map((message, index) => {
    const where = `第 ${index + 1} 条消息`
    if (!isRecord(message)) fail(`${where} 要写 from 和 text`)
    only(message, ['from', 'text', 'reply'], where)
    const base = { from: text(message.from, `${where} 的 from`, { max: 10 }), text: text(message.text, `${where} 的 text`, { max: 80 }) }
    if (message.reply === undefined) return { ...base, replies: {} }
    if (modes.length === 0) return { ...base, replies: { '': text(message.reply, `${where} 的 reply`, { max: 80 }) } }
    if (!isRecord(message.reply)) fail(`${where} 的 reply 要按方式写，比如 ${modes[0].id}: 回复内容`)
    const replies = {}
    for (const [mode, value] of Object.entries(message.reply)) {
      if (!modeIds.has(mode)) fail(`${where} 的 reply 里没有 ${mode} 这种方式`)
      // A reply that is the same in several modes is written once and named by the others: `every: mention`.
      replies[mode] = typeof value === 'string' && modeIds.has(value) ? value : text(value, `${where} 的 reply.${mode}`, { max: 80 })
    }
    for (const [mode, value] of Object.entries(replies))
      if (modeIds.has(value)) {
        const target = replies[value]
        if (target === undefined || modeIds.has(target)) fail(`${where} 的 reply.${mode} 指向的 ${value} 没有写回复`)
        replies[mode] = target
      }
    return { ...base, replies }
  })
  return { agent: text(raw.agent, 'agent', { max: 10 }), modes, messages }
}

/** 链路动画: something passing through a fixed series of stages, each with a short note and what happens there. */
const pipeline = (raw) => {
  only(raw, ['id', 'title', 'stages'], '链路动画')
  return {
    stages: list(raw.stages, 'stages', { min: 2, max: MAX_STEPS }).map((stage, index) => {
      const where = `第 ${index + 1} 环`
      if (!isRecord(stage)) fail(`${where} 要写 label 和 detail`)
      only(stage, ['label', 'note', 'detail'], where)
      return {
        label: text(stage.label, `${where} 的 label`, { max: 8 }),
        ...(stage.note === undefined ? {} : { note: text(stage.note, `${where} 的 note`, { max: 16 }) }),
        detail: text(stage.detail, `${where} 的 detail`, { max: 120 }),
      }
    }),
  }
}

const KINDS = { tour, diagram, wizard, chat, pipeline }

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
  if (kind === 'wizard') {
    // Steps get short names (问题 1, 办法 2) so the tree reads flat: an agent can ask one question at a time and jump.
    const names = new Map()
    let questions = 0
    let answers = 0
    for (const step of data.steps) names.set(step.id, step.ask === undefined ? `办法 ${++answers}` : `问题 ${++questions}`)
    return [
      `排查向导「${title}」：一问一答，从问题 1 开始，按回答跳到下一步，直到一个办法。可以照着在聊天里一问一答地带对方排查。`,
      ...data.steps.map((step) =>
        step.ask === undefined
          ? `${names.get(step.id)}：${step.answer}${step.link === undefined ? '' : `（详见 ${step.link}）`}`
          : `${names.get(step.id)}：${step.ask}\n${step.choices.map((choice) => `  - ${choice.label} → ${names.get(choice.next)}`).join('\n')}`,
      ),
    ].join('\n')
  }
  if (kind === 'chat') {
    const lines = [
      data.modes.length === 0
        ? `聊天回放「${title}」：一段模拟群聊，智能体叫「${data.agent}」。`
        : `聊天回放「${title}」：一段模拟群聊，智能体叫「${data.agent}」；可以切换 ${data.modes.map((mode) => mode.label).join('、')}，看她在每种方式下回哪几条。`,
      ...data.modes.flatMap((mode) => (mode.note === undefined ? [] : [`- ${mode.label}：${mode.note}`])),
    ]
    const labelOf = new Map(data.modes.map((mode) => [mode.id, mode.label]))
    data.messages.forEach((message, index) => {
      lines.push(`${index + 1}. ${message.from}：${message.text}`)
      if (data.modes.length === 0) {
        if (message.replies[''] !== undefined) lines.push(`   ${data.agent} 回：${message.replies['']}`)
        return
      }
      // Modes with the same reply are said together; modes she stays quiet in are named, since that is the point.
      const byReply = new Map()
      for (const mode of data.modes) {
        const reply = message.replies[mode.id] ?? null
        byReply.set(reply, [...(byReply.get(reply) ?? []), labelOf.get(mode.id)])
      }
      for (const [reply, modes] of byReply)
        lines.push(`   ${modes.join('、')}：${reply === null ? '不回' : `${data.agent} 回「${reply}」`}`)
    })
    return lines.join('\n')
  }
  if (kind === 'pipeline')
    return [
      `链路动画「${title}」：依次经过 ${data.stages.length} 环。`,
      ...data.stages.map(
        (stage, index) => `${index + 1}. ${stage.label}${stage.note === undefined ? '' : `（${stage.note}）`}：${stage.detail}`,
      ),
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
  if (widget.kind === 'chat' && widget.data.modes.length > 0) {
    const [first, ...rest] = widget.data.modes
    return [
      { state: 'overview', label: `${widget.title}：选“${first.label}”时她回的消息` },
      ...rest.map((mode) => ({ state: `mode-${mode.id}`, label: `${widget.title}：选“${mode.label}”时她回的消息` })),
    ]
  }
  if (widget.kind === 'pipeline')
    return [
      { state: 'overview', label: `${widget.title}：${widget.data.stages.map((stage) => stage.label).join(' → ')}` },
      ...widget.data.stages.map((stage, index) => ({
        state: `step-${index + 1}`,
        label: `第 ${index + 1} 环「${stage.label}」：${stage.detail}`,
      })),
    ]
  if (widget.kind === 'wizard') return [{ state: 'overview', label: `${widget.title}：第一个问题` }]
  return [{ state: 'overview', label: widget.title }]
}

/** Widgets that move get a GIF too: a chat plays in its first mode, a pipeline passes through every stage. */
export const widgetAnimates = (widget) =>
  widget.kind === 'chat' ||
  widget.kind === 'pipeline' ||
  (widget.kind === 'diagram' && widget.data.type === 'flow' && widget.data.animate)

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
