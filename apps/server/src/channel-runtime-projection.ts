import type { AgentId, ChannelId, ChannelRuntimePhase, ChannelRuntimeProjection, EpisodeId } from '@nekro-nxt/contracts'
import { z } from 'zod'

const ToolArgumentObjectSchema = z.record(z.string(), z.unknown())

const PREVIEW_LIMIT = 160
const TURN_LIMIT = 24
const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|credential/iu

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  send_channel_message: '发送频道消息',
  web_search: '网页搜索',
  web_fetch: '获取网页',
  subagent: '子智能体',
  send_message: '向子智能体发消息',
  interrupt_agent: '中断子智能体',
  list_agents: '列出子智能体',
  bash: '运行命令',
  shell: '运行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  grep: '搜索文件',
  glob: '查找文件',
}

export type RuntimeSessionStatus = 'idle' | 'running' | 'missing'

export type RuntimeProjectionEvent =
  | { readonly type: 'turn/start'; readonly turn: number }
  | {
      readonly type: 'turn/end'
      readonly turn: number
      readonly reasonKind: string
      readonly errorCode?: string
      readonly errorMessage?: string
    }
  | { readonly type: 'step/start'; readonly turn: number; readonly step: number }
  | { readonly type: 'step/end'; readonly turn: number; readonly step: number }
  | {
      readonly type: 'tool/call'
      readonly turn: number
      readonly step: number
      readonly callId: string
      readonly name: string
      readonly arguments: string
    }
  | {
      readonly type: 'tool/result'
      readonly turn: number
      readonly step: number
      readonly callId: string
      readonly failed: boolean
      readonly resultPreview?: string
    }
  | {
      readonly type: 'assistant/message'
      readonly turn: number
      readonly step: number
      readonly text?: string
      readonly reasoning?: string
    }

export interface ChannelRuntimeProjectionInput {
  readonly channelId: ChannelId
  readonly agentId?: AgentId
  readonly episodeId?: EpisodeId
  readonly sessionStatus: RuntimeSessionStatus
  readonly pendingInjectCount: number
  readonly events: readonly RuntimeProjectionEvent[]
}

type ProjectedTool = {
  callId: string
  name: string
  displayName: string
  state: 'running' | 'succeeded' | 'failed'
  inputPreview?: string
  resultPreview?: string
  wroteToChannel?: boolean
}

type ProjectedStep = {
  step: number
  tools: Map<string, ProjectedTool>
  text?: string
  reasoning?: string
}

type ProjectedTurn = {
  turn: number
  state: ChannelRuntimeProjection['turns'][number]['state']
  producedReply: boolean
  error?: { code: string; message: string }
  steps: Map<number, ProjectedStep>
}

const phaseRank = (phase: ChannelRuntimePhase): number => {
  if (phase === 'unavailable') return 4
  if (phase === 'using-tool') return 3
  if (phase === 'thinking') return 2
  if (phase === 'waiting-input') return 1
  return 0
}

export const worstChannelRuntimePhase = (phases: readonly ChannelRuntimePhase[]): ChannelRuntimePhase =>
  phases.reduce<ChannelRuntimePhase>(
    (current, phase) => (phaseRank(phase) > phaseRank(current) ? phase : current),
    'idle',
  )

export const toolDisplayName = (name: string): string => TOOL_DISPLAY_NAMES[name] ?? name.replaceAll('_', ' ')

export const previewText = (value: string): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= PREVIEW_LIMIT) return normalized
  return `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

export const previewToolArguments = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const parsed = ToolArgumentObjectSchema.safeParse(JSON.parse(trimmed))
    if (parsed.success) {
      const redacted = Object.fromEntries(
        Object.entries(parsed.data).map(([key, value]) => [key, SECRET_KEY.test(key) ? '***' : value]),
      )
      return previewText(JSON.stringify(redacted))
    }
  } catch {
    // Keep the raw model argument string when it is not JSON.
  }
  return previewText(trimmed)
}

const turnStateFromReason = (reasonKind: string): ProjectedTurn['state'] => {
  if (
    reasonKind === 'aborted' ||
    reasonKind === 'error' ||
    reasonKind === 'max-tokens' ||
    reasonKind === 'interrupted'
  ) {
    return reasonKind
  }
  return 'completed'
}

export const emptyChannelRuntimeProjection = (
  channelId: ChannelId,
  extras: {
    readonly agentId?: AgentId
    readonly episodeId?: EpisodeId
    readonly pendingInjectCount?: number
  } = {},
): ChannelRuntimeProjection => ({
  channelId,
  ...(extras.agentId === undefined ? {} : { agentId: extras.agentId }),
  ...(extras.episodeId === undefined ? {} : { episodeId: extras.episodeId }),
  phase: 'idle',
  summary: extras.agentId === undefined ? '尚未绑定智能体。' : '智能体当前空闲。',
  pendingInjectCount: extras.pendingInjectCount ?? 0,
  turns: [],
})

export const projectChannelRuntime = (input: ChannelRuntimeProjectionInput): ChannelRuntimeProjection => {
  const turns = new Map<number, ProjectedTurn>()

  const ensureTurn = (turn: number): ProjectedTurn => {
    const existing = turns.get(turn)
    if (existing) return existing
    const created: ProjectedTurn = { turn, state: 'in-progress', producedReply: false, steps: new Map() }
    turns.set(turn, created)
    return created
  }

  const ensureStep = (turn: number, step: number): ProjectedStep => {
    const record = ensureTurn(turn)
    const existing = record.steps.get(step)
    if (existing) return existing
    const created: ProjectedStep = { step, tools: new Map() }
    record.steps.set(step, created)
    return created
  }

  for (const event of input.events) {
    if (event.type === 'turn/start') {
      ensureTurn(event.turn)
      continue
    }
    if (event.type === 'turn/end') {
      const record = ensureTurn(event.turn)
      record.state = turnStateFromReason(event.reasonKind)
      if (event.reasonKind === 'error') {
        record.error = {
          code: event.errorCode?.trim() || 'UNKNOWN',
          message: event.errorMessage?.trim() || '本轮执行失败。',
        }
      }
      continue
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      ensureStep(event.turn, event.step)
      continue
    }
    if (event.type === 'tool/call') {
      const step = ensureStep(event.turn, event.step)
      const inputPreview = previewToolArguments(event.arguments)
      step.tools.set(event.callId, {
        callId: event.callId,
        name: event.name,
        displayName: toolDisplayName(event.name),
        state: 'running',
        ...(inputPreview === undefined ? {} : { inputPreview }),
        ...(event.name === 'send_channel_message' ? { wroteToChannel: false } : {}),
      })
      continue
    }
    if (event.type === 'tool/result') {
      const step = ensureStep(event.turn, event.step)
      const current = step.tools.get(event.callId)
      const name = current?.name ?? 'tool'
      step.tools.set(event.callId, {
        callId: event.callId,
        name,
        displayName: current?.displayName ?? toolDisplayName(name),
        state: event.failed ? 'failed' : 'succeeded',
        ...(current?.inputPreview === undefined ? {} : { inputPreview: current.inputPreview }),
        ...(event.resultPreview === undefined ? {} : { resultPreview: previewText(event.resultPreview) }),
        ...(name === 'send_channel_message' ? { wroteToChannel: !event.failed } : {}),
      })
      if (!event.failed && name === 'send_channel_message') ensureTurn(event.turn).producedReply = true
      continue
    }
    const step = ensureStep(event.turn, event.step)
    if (event.text?.trim()) step.text = event.text
    if (event.reasoning?.trim()) step.reasoning = event.reasoning
  }

  const orderedTurns = [...turns.values()]
    .sort((left, right) => left.turn - right.turn)
    .slice(-TURN_LIMIT)
    .map((record) => ({
      turn: record.turn,
      state: record.state,
      producedReply: record.producedReply,
      ...(record.error === undefined ? {} : { error: record.error }),
      steps: [...record.steps.values()]
        .sort((left, right) => left.step - right.step)
        .map((step) => ({
          step: step.step,
          tools: [...step.tools.values()],
          ...(step.text || step.reasoning
            ? {
                internalOutput: {
                  kind: 'internal-output' as const,
                  ...(step.text === undefined ? {} : { text: step.text }),
                  ...(step.reasoning === undefined ? {} : { reasoning: step.reasoning }),
                },
              }
            : {}),
        })),
    }))

  const latest = orderedTurns.at(-1)
  const runningTools = latest?.steps.flatMap((step) => step.tools.filter((tool) => tool.state === 'running')) ?? []
  const failedTurn = latest?.state === 'error' ? latest : undefined
  let phase: ChannelRuntimePhase = 'idle'
  if (failedTurn && input.sessionStatus !== 'running') phase = 'unavailable'
  else if (input.sessionStatus === 'running' && runningTools.length > 0) phase = 'using-tool'
  else if (input.sessionStatus === 'running') phase = 'thinking'

  const currentTool = runningTools[0]
  const summary =
    input.agentId === undefined
      ? '尚未绑定智能体。'
      : phase === 'using-tool' && currentTool
        ? `智能体正在使用${currentTool.displayName}。`
        : phase === 'thinking'
          ? '智能体正在处理当前消息。'
          : phase === 'unavailable'
            ? failedTurn?.error?.message
              ? `智能体本轮失败：${failedTurn.error.message}`
              : '智能体当前不可用，请检查模型和连接设置。'
            : '智能体当前空闲。'

  return {
    channelId: input.channelId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.episodeId === undefined ? {} : { episodeId: input.episodeId }),
    phase,
    summary,
    pendingInjectCount: input.pendingInjectCount,
    turns: orderedTurns,
  }
}
