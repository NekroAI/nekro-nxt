import { hueOf, identityHue, type Tone } from '../../ui-kit/index.js'
import {
  connectionDisplayName,
  type AgentSummary,
  type ConnectionState,
  type ConnectionSummary,
} from '../../product-runtime.js'

/** Agent identity hue: explicit appearance when the Host provides one, otherwise stable from the id. */
export const agentHue = (agent: Pick<AgentSummary, 'id' | 'appearance'>): number =>
  agent.appearance?.hue === undefined ? hueOf(agent.id) : identityHue(agent.appearance.hue)

/** CSS color for the agent's identity accent (lines, bars, wires). */
export const agentAccent = (agent: Parameters<typeof agentHue>[0]): string => `hsl(${agentHue(agent)} 58% 58%)`

/** A channel's own identity hue, stable from its id. */
export const channelHue = (channelId: string): number => hueOf(channelId)

/** Series hues for channels drawn together: spaced around the wheel and clear of the danger red. */
const SERIES_HUES = [212, 158, 38, 268, 188, 92, 318, 240, 128, 62] as const

/**
 * Hues for channels drawn together (charts, legends, cards): each channel starts from a stable slot in the series
 * palette and takes the next free one, so neighbouring series never share a colour and no series reads as an error.
 */
export const distinctChannelHues = (channelIds: readonly string[]): ReadonlyMap<string, number> => {
  const taken = new Set<number>()
  const result = new Map<string, number>()
  for (const id of [...channelIds].sort()) {
    let slot = Math.floor(channelHue(id)) % SERIES_HUES.length
    for (let attempt = 0; attempt < SERIES_HUES.length && taken.has(slot); attempt += 1)
      slot = (slot + 1) % SERIES_HUES.length
    if (taken.size < SERIES_HUES.length) taken.add(slot)
    result.set(id, SERIES_HUES.at(slot) ?? 212)
  }
  return result
}

export const isAgentWorking = (agent: Pick<AgentSummary, 'state'> | undefined): boolean =>
  agent !== undefined && (agent.state === 'thinking' || agent.state === 'using-tool' || agent.state === 'compacting')

export const agentPhase: Record<AgentSummary['state'], { readonly label: string; readonly tone: Tone }> = {
  idle: { label: '空闲', tone: 'neutral' },
  thinking: { label: '思考中', tone: 'accent' },
  'using-tool': { label: '使用工具', tone: 'accent' },
  compacting: { label: '压缩中', tone: 'accent' },
  'waiting-input': { label: '等待输入', tone: 'warn' },
  unavailable: { label: '不可用', tone: 'bad' },
}

export const connectionTone = (state: ConnectionState): Tone => {
  switch (state) {
    case '已连接':
      return 'ok'
    case '正在连接':
    case '已配置':
      return 'warn'
    case '认证过期':
    case '已断开':
    case '异常':
      return 'bad'
  }
}

export const connectionLabel = connectionDisplayName

/** Primary label plus the platform name when an alias hides it. */
export const connectionFullLabel = (connection: Pick<ConnectionSummary, 'alias' | 'name' | 'adapter'>): string => {
  const primary = connectionDisplayName(connection)
  return primary === connection.adapter ? primary : `${primary} · ${connection.adapter}`
}

export type TriggerPolicy = 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'

const TRIGGER_POLICIES: readonly string[] = [
  'always',
  'mentioned-or-replied',
  'command',
  'observe-only',
] satisfies TriggerPolicy[]

export const isTriggerPolicy = (value: string): value is TriggerPolicy => TRIGGER_POLICIES.includes(value)

export const triggerLabel: Record<string, string> = {
  always: '每条消息',
  'mentioned-or-replied': '被提及时',
  command: '平台命令事件',
  'observe-only': '仅观察',
}
