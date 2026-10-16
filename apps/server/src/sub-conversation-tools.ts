import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SubConversationIdSchema, type SubConversation } from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { SubConversationManager, SubConversationStore } from './sub-conversations.js'
import type { SubConversationRecord } from '@nekro-nxt/storage-sqlite'

/** Only the channel conversation opens, lists and removes sub-conversations; a sub-conversation reports and ends. */
export const PARENT_ONLY_CONVERSATION_TOOLS = ['conversation_open', 'conversation_delete', 'conversation_list'] as const

const OpenSchema = z.object({ title: z.string().trim().min(1).max(60), task: z.string().trim().min(1).max(8000) })
const SendSchema = z.object({
  conversation: SubConversationIdSchema.optional(),
  text: z.string().trim().min(1).max(8000),
})
const CloseSchema = z.object({
  conversation: SubConversationIdSchema.optional(),
  summary: z.string().trim().max(4000).optional(),
})
const DeleteSchema = z.object({ conversation: SubConversationIdSchema })

const STATUS: Readonly<Record<SubConversation['status'], string>> = { open: '进行中', closed: '已结束' }

const brief = (record: SubConversationRecord) => ({
  id: record.id,
  title: record.title,
  status: record.status,
  ...(record.summary === undefined ? {} : { summary: record.summary }),
})

const requireAgent = (exec: { readonly agent?: Agent | undefined }): Agent => {
  if (exec.agent === undefined) throw new Error('子对话工具只能在对话里使用。')
  return exec.agent
}

const idOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true } },
  },
} as const

export const subConversationTools = (
  manager: SubConversationManager,
  store: Pick<SubConversationStore, 'listSubConversations' | 'getSubConversationBySession'>,
) => [
  defineTool({
    name: 'conversation_open',
    description:
      '开一个子对话，把一件需要单独处理的事交给它：它有自己的上下文，不占用这里的对话，也不能在频道里发言。它每次回复都会送回这里。事情办完后用 conversation_close 结束它。',
    parameters: {
      title: { type: 'string', required: true, description: '这件事的简短名称，显示在频道下面，最多 60 字。' },
      task: { type: 'string', required: true, description: '交给它的完整说明：要做什么、已知什么、做完交回什么。' },
    },
    output: {
      ...idOutput,
      render: (_arguments, value) => {
        const result = z.object({ id: z.string(), title: z.string() }).parse(value)
        return [{ type: 'text', text: `已开子对话「${result.title}」（${result.id}），它的回复会送回这里。` }]
      },
    },
    execute: async (args, exec) => {
      const parsed = OpenSchema.parse(args)
      const record = await manager.open({ parent: requireAgent(exec), title: parsed.title, task: parsed.task })
      return { id: record.id, title: record.title }
    },
  }),
  defineTool({
    name: 'conversation_send',
    description: '给子对话补充说明或追问；在子对话里使用时，不填 conversation，内容送回开它的频道对话。',
    parameters: {
      conversation: { type: 'string', description: '子对话 ID（cnv_…）；在子对话里使用时留空。' },
      text: { type: 'string', required: true, description: '要说的内容。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: '已送达。' }],
    },
    execute: async (args, exec) => {
      const parsed = SendSchema.parse(args)
      const agent = requireAgent(exec)
      const conversation = parsed.conversation ?? store.getSubConversationBySession(agent.id)?.id
      if (conversation === undefined) throw new Error('请填写要发给哪个子对话（cnv_…）。')
      await manager.send({ sender: agent, conversationId: conversation, text: parsed.text })
      return { sent: true }
    },
  }),
  defineTool({
    name: 'conversation_close',
    description:
      '结束一个子对话，并写下它的结论。在子对话里使用时，不填 conversation，结束的是它自己。结束后记录还能查看，但不能再发消息。',
    parameters: {
      conversation: { type: 'string', description: '子对话 ID（cnv_…）；在子对话里使用时留空。' },
      summary: { type: 'string', description: '这件事的结论，最多 4000 字。' },
    },
    output: {
      ...idOutput,
      render: (_arguments, value) => {
        const result = z.object({ id: z.string(), title: z.string() }).parse(value)
        return [{ type: 'text', text: `子对话「${result.title}」已结束。` }]
      },
    },
    execute: async (args, exec) => {
      const parsed = CloseSchema.parse(args)
      const record = await manager.closeByAgent({
        caller: requireAgent(exec),
        ...(parsed.conversation === undefined ? {} : { conversationId: parsed.conversation }),
        ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
      })
      return { id: record.id, title: record.title }
    },
  }),
  defineTool({
    name: 'conversation_delete',
    description: '销毁一个已经结束、由你开的子对话，连同它的记录一起删除；不销毁的会在设置的保留时间后自动清理。',
    parameters: { conversation: { type: 'string', required: true, description: '子对话 ID（cnv_…）。' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { deleted: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: '子对话已销毁。' }],
    },
    execute: async (args, exec) => {
      const parsed = DeleteSchema.parse(args)
      await manager.delete(parsed.conversation, { agent: requireAgent(exec) })
      return { deleted: true }
    },
  }),
  defineTool({
    name: 'conversation_list',
    description: '列出这个频道对话开过的子对话和它们的状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } },
      },
      render: (_arguments, value) => {
        const items = z
          .object({
            items: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['open', 'closed']) })),
          })
          .parse(value).items
        if (items.length === 0) return [{ type: 'text', text: '还没有子对话。' }]
        return [
          { type: 'text', text: items.map((item) => `${item.id} ${item.title}（${STATUS[item.status]}）`).join('\n') },
        ]
      },
    },
    execute: (_args, exec) => {
      const agent = requireAgent(exec)
      const items = store
        .listSubConversations({})
        .filter((record) => record.parentDshSessionId === agent.id)
        .slice(0, 50)
        .map(brief)
      return Promise.resolve({ items })
    },
  }),
]
