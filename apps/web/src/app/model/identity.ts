import { hueOf, type Tone } from '../../ui-kit/next/index.js'
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

export const triggerLabel: Record<string, string> = {
  always: '每条消息',
  'mentioned-or-replied': '被提及时',
  command: '命令触发',
  'observe-only': '仅观察',
}
