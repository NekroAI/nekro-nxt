import { CommandDefinitionSchema } from '@nekro-nxt/contracts'
import type { BindingRecord } from '@nekro-nxt/core'

export const BUILTIN_DEFINITIONS = [
  {
    name: 'help',
    description: '查看可用命令、参数和示例',
    parameters: [{ name: '命令', kind: 'positional', type: 'string' }],
  },
  { name: 'status', description: '查看当前频道绑定、响应模式与运行状态' },
  { name: 'stop', description: '停止当前轮次，保留上下文', minimumPermission: 'channel-admin' },
  { name: 'reset', description: '清空当前上下文，保留聊天历史', minimumPermission: 'channel-admin' },
  { name: 'compact', description: '压缩当前上下文', minimumPermission: 'channel-admin' },
  { name: 'off', description: '保存当前策略并切换为仅观察', minimumPermission: 'channel-admin' },
  { name: 'on', description: '恢复自动响应策略', minimumPermission: 'channel-admin' },
].map((value) => CommandDefinitionSchema.parse(value))
export const RESPONSE_MODE_LABELS: Record<BindingRecord['triggerPolicy'], string> = {
  always: '始终响应',
  'mentioned-or-replied': '提及或回复时响应',
  command: '命令触发',
  'observe-only': '仅观察',
}
