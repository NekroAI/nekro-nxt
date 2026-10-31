import { CommandDefinitionSchema, type CommandDefinition } from '@nekro-nxt/contracts'
import type { BindingRecord } from '@nekro-nxt/core'
import { textResult, type RegisteredCommand } from './types.js'

export const RESPONSE_MODE_LABELS: Record<BindingRecord['triggerPolicy'], string> = {
  always: '始终响应',
  'mentioned-or-replied': '提及或回复时响应',
  smart: '智能响应',
  command: '平台命令事件',
  'observe-only': '仅观察',
}

const define = (value: unknown): CommandDefinition => CommandDefinitionSchema.parse(value)

/**
 * Built-in commands are ordinary registrations: they are listed, authorized and executed through the same path as
 * extension commands. Business behavior (stop, reset, pause) stays with the channel runtime; these handlers only
 * call it through the execution context.
 */
const BUILTIN_HANDLERS: readonly Omit<RegisteredCommand, 'fullName' | 'source'>[] = [
  {
    definition: define({
      name: 'help',
      description: '查看可用命令、参数和示例',
      parameters: [{ name: '命令', kind: 'positional', type: 'string' }],
    }),
    invoke: (context, host) =>
      host.help(typeof context.arguments['命令'] === 'string' ? context.arguments['命令'] : undefined),
  },
  {
    definition: define({ name: 'status', description: '查看当前频道绑定、响应模式、暂停与运行状态' }),
    invoke: (_context, host) => textResult(host.statusText()),
  },
  {
    definition: define({
      name: 'stop',
      description: '停止当前轮次，保留上下文；之后的新消息仍会触发回应',
      minimumPermission: 'channel-admin',
    }),
    invoke: async (context) => {
      const outcome = await context.host.stop()
      return textResult(
        outcome.stopped ? '当前轮次已停止，上下文已保留；之后的新消息仍会触发回应。' : '当前没有运行中的任务。',
      )
    },
  },
  {
    definition: define({
      name: 'reset',
      description: '停止当前工作并从新的上下文开始，聊天历史、频道说明和笔记保留',
      minimumPermission: 'channel-admin',
    }),
    invoke: async (context) => {
      context.reply(textResult('正在重置当前上下文…'))
      await context.host.reset('clear')
      return textResult('当前上下文已清空，聊天历史已保留。')
    },
  },
  {
    definition: define({
      name: 'compact',
      description: '整理当前上下文，会中断当前工作',
      minimumPermission: 'channel-admin',
    }),
    invoke: async (context) => {
      context.reply(textResult('正在整理当前上下文，当前工作会被中断…'))
      await context.host.reset('compact')
      return textResult('当前上下文已整理。')
    },
  },
  {
    definition: define({
      name: 'pause',
      aliases: ['off'],
      description: '暂停当前频道的所有自动响应并停止当前轮次，响应规则保留',
      minimumPermission: 'channel-admin',
    }),
    invoke: async (_context, host) => {
      const outcome = await host.pause()
      return textResult(
        outcome.changed
          ? `已暂停当前频道的自动响应${outcome.stopped ? '，并停止了当前轮次' : ''}。响应规则不变，输入 /resume 恢复。`
          : '当前频道已处于暂停状态。',
      )
    },
  },
  {
    definition: define({
      name: 'resume',
      aliases: ['on'],
      description: '解除当前频道的暂停，按当前响应规则恢复，不重跑已停止的任务',
      minimumPermission: 'channel-admin',
    }),
    invoke: async (_context, host) => {
      const outcome = await host.resume()
      return textResult(
        outcome.changed
          ? '已恢复当前频道的自动响应，按当前响应规则回应；之前停止的任务不会重跑。'
          : '当前频道没有暂停。',
      )
    },
  },
  {
    definition: define({
      name: 'ext',
      description:
        '查看和管理当前智能体的扩展：不带参数列出扩展、进行中的任务和待确认请求；管理员可以确认请求、允许候选运行、启停、回退和切换版本',
      parameters: [
        {
          name: '操作',
          kind: 'positional',
          type: 'string',
          description: 'info、approve、reject、run、enable、disable、revert、use、save、continue、update、publish',
        },
        {
          name: '对象',
          kind: 'positional',
          type: 'string',
          description: '请求编号、扩展名称或任务名称；approve、reject 后跟任务名称时针对它等待运行的候选',
        },
        { name: '值', kind: 'positional', type: 'string', description: '版本号（如 v2）或拒绝原因' },
      ],
      examples: ['/ext', '/ext approve 12', '/ext run 天气卡片', '/ext revert 用户屏蔽', '/ext use 用户屏蔽 v2'],
    }),
    invoke: async (context, host) => {
      if (!host.governance) throw new Error('这台 NekroNXT 没有开启扩展管理。')
      const text = (name: string) => (typeof context.arguments[name] === 'string' ? context.arguments[name] : undefined)
      const subcommand = text('操作')
      const target = text('对象')
      const value = text('值')
      return textResult(
        await host.governance.ext({
          ...(subcommand === undefined ? {} : { subcommand }),
          ...(target === undefined ? {} : { target }),
          ...(value === undefined ? {} : { value }),
        }),
      )
    },
  },
  {
    definition: define({
      name: 'admin',
      description: '认领或查看 NekroNXT 管理员：用设置里生成的认领码把自己的账号设为管理员',
      parameters: [
        { name: '操作', kind: 'positional', type: 'string', description: 'claim、list' },
        { name: '值', kind: 'positional', type: 'string', description: '认领码' },
      ],
      examples: ['/admin claim 482913', '/admin list'],
    }),
    invoke: async (context, host) => {
      if (!host.governance) throw new Error('这台 NekroNXT 没有开启管理员设置。')
      const action = typeof context.arguments['操作'] === 'string' ? context.arguments['操作'] : undefined
      const value = typeof context.arguments['值'] === 'string' ? context.arguments['值'] : undefined
      return textResult(
        await host.governance.admin({
          ...(action === undefined ? {} : { action }),
          ...(value === undefined ? {} : { value }),
        }),
      )
    },
  },
]

export const BUILTIN_COMMANDS: readonly RegisteredCommand[] = BUILTIN_HANDLERS.map((entry) => ({
  ...entry,
  fullName: entry.definition.name,
  source: '内置',
}))
