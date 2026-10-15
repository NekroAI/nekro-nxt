import { CommandDefinitionSchema } from '@nekro-nxt/contracts'
import type { BindingRecord } from '@nekro-nxt/core'

export const BUILTIN_DEFINITIONS = [
  {
    name: 'help',
    description: '查看可用命令、参数和示例',
    parameters: [{ name: '命令', kind: 'positional', type: 'string' }],
  },
  { name: 'status', description: '查看当前频道绑定、响应模式与运行状态' },
  {
    name: 'stop',
    description: '停止当前轮次，保留上下文；之后的新消息仍会触发回应',
    minimumPermission: 'channel-admin',
  },
  {
    name: 'reset',
    description: '停止当前工作并从新的上下文开始，聊天历史、频道说明和笔记保留',
    minimumPermission: 'channel-admin',
  },
  { name: 'compact', description: '整理当前上下文，会中断当前工作', minimumPermission: 'channel-admin' },
  {
    name: 'pause',
    aliases: ['off'],
    description: '暂停当前频道的所有自动响应并停止当前轮次，响应规则保留',
    minimumPermission: 'channel-admin',
  },
  {
    name: 'resume',
    aliases: ['on'],
    description: '解除当前频道的暂停，按当前响应规则恢复，不重跑已停止的任务',
    minimumPermission: 'channel-admin',
  },
].map((value) => CommandDefinitionSchema.parse(value))
export const RESPONSE_MODE_LABELS: Record<BindingRecord['triggerPolicy'], string> = {
  always: '始终响应',
  'mentioned-or-replied': '提及或回复时响应',
  command: '命令触发',
  'observe-only': '仅观察',
}
