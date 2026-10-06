import { hueOf, type Tone } from '../../ui-kit/index.js'
import {
  connectionDisplayName,
  type AgentSummary,
  type ConnectionState,
  type ConnectionSummary,
} from '../../product-runtime.js'

/** Agent identity hue: explicit appearance when the Host provides one, otherwise stable from the id. */
export const agentHue = (agent: Pick<AgentSummary, 'id' | 'appearance'>): number =>
  agent.appearance?.hue ?? hueOf(agent.id)

/** CSS color for the agent's identity accent (lines, bars, wires). */
export const agentAccent = (agent: Parameters<typeof agentHue>[0]): string => `hsl(${agentHue(agent)} 58% 58%)`

/** A channel's own identity hue, stable from its id. */
export const channelHue = (channelId: string): number => hueOf(channelId)

/**
 * Hues for channels drawn together (charts, legends): each starts from its stable hue and steps around the wheel
 * until it is at least 36° from those already placed, so neighbouring series never share a colour.
 */
export const distinctChannelHues = (channelIds: readonly string[]): ReadonlyMap<string, number> => {
  const placed: number[] = []
  const result = new Map<string, number>()
  for (const id of [...channelIds].sort()) {
    let hue = channelHue(id)
    for (
      let attempt = 0;
      attempt < 8 && placed.some((other) => Math.min(Math.abs(other - hue), 360 - Math.abs(other - hue)) < 36);
      attempt += 1
    ) {
      hue = (hue + 47) % 360
    }
    placed.push(hue)
    result.set(id, hue)
  }
  return result
}

export const isAgentWorking = (agent: Pick<AgentSummary, 'state'> | undefined): boolean =>
  agent !== undefined && (agent.state === 'thinking' || agent.state === 'using-tool')

export const agentPhase: Record<AgentSummary['state'], { readonly label: string; readonly tone: Tone }> = {
  idle: { label: '空闲', tone: 'neutral' },
  thinking: { label: '思考中', tone: 'accent' },
  'using-tool': { label: '使用工具', tone: 'accent' },
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
  command: '命令触发',
  'observe-only': '仅观察',
}
