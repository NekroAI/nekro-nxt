import type { AgentSummary } from './product-store.js'

export type AgentAccessLevel = 0 | 1 | 2 | 3
export type AgentAccessPreset = AgentAccessLevel | 'custom'

export const AGENT_ACCESS_LEVELS: readonly {
  readonly level: AgentAccessLevel
  readonly code: `Lv.${AgentAccessLevel}`
  readonly label: string
  readonly risk: string
  readonly tone: 'neutral' | 'info' | 'warning' | 'error'
  readonly description: string
}[] = [
  {
    level: 0,
    code: 'Lv.0',
    label: '基础权限',
    risk: '无额外访问',
    tone: 'neutral',
    description: '不授予文件读写、命令运行或完整访问。',
  },
  {
    level: 1,
    code: 'Lv.1',
    label: '文件读写',
    risk: '受限访问',
    tone: 'info',
    description: '可以读取文件，并在智能体工作区内写入文件；不能运行命令。',
  },
  {
    level: 2,
    code: 'Lv.2',
    label: '运行命令',
    risk: '高风险',
    tone: 'warning',
    description: '包含文件读写，并允许在智能体工作区中运行命令。',
  },
  {
    level: 3,
    code: 'Lv.3',
    label: '完整访问',
    risk: '极高风险',
    tone: 'error',
    description: '包含文件读写和命令运行，并扩大到宿主进程被允许访问的系统范围。',
  },
]

export const agentAccessLevel = (capabilities: AgentSummary['capabilities']): AgentAccessLevel => {
  if (capabilities.unrestrictedFileAccess) return 3
  if (capabilities.developmentShell) return 2
  if (capabilities.fileTools) return 1
  return 0
}

export const agentAccessPreset = (capabilities: AgentSummary['capabilities']): AgentAccessPreset => {
  const { fileTools, developmentShell, unrestrictedFileAccess } = capabilities
  if (!fileTools && !developmentShell && !unrestrictedFileAccess) return 0
  if (fileTools && !developmentShell && !unrestrictedFileAccess) return 1
  if (fileTools && developmentShell && !unrestrictedFileAccess) return 2
  if (fileTools && developmentShell && unrestrictedFileAccess) return 3
  return 'custom'
}

export const agentAccessLevelOption = (level: AgentAccessLevel) => AGENT_ACCESS_LEVELS[level]!

export const agentAccessPresentation = (capabilities: AgentSummary['capabilities']) => {
  const preset = agentAccessPreset(capabilities)
  if (preset !== 'custom') return agentAccessLevelOption(preset)
  const enabled = [
    capabilities.fileTools ? '文件读写' : '',
    capabilities.developmentShell ? '运行命令' : '',
    capabilities.unrestrictedFileAccess ? '完整访问' : '',
  ].filter(Boolean)
  return {
    level: 'custom' as const,
    code: 'Lv.C' as const,
    label: '自定义权限',
    risk: '自定义组合',
    tone: 'warning' as const,
    description: enabled.length > 0 ? `已开启：${enabled.join('、')}。` : '当前没有开启系统访问能力。',
  }
}

export const agentAccessCapabilities = (
  level: AgentAccessLevel,
): Pick<AgentSummary['capabilities'], 'fileTools' | 'developmentShell' | 'unrestrictedFileAccess'> => ({
  fileTools: level >= 1,
  developmentShell: level >= 2,
  unrestrictedFileAccess: level >= 3,
})

export const nearestAgentAccessLevel = (position: number): AgentAccessLevel => {
  if (!Number.isFinite(position) || position < 0.5) return 0
  if (position < 1.5) return 1
  if (position < 2.5) return 2
  return 3
}
