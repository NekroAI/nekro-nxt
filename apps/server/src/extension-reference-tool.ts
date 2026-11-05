import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  NEKRO_NXT_EXTENSION_REFERENCE_TOPICS,
  findNekroNxtExtensionReferenceTopic,
  renderNekroNxtExtensionReferenceTopic,
} from '@nekro-nxt/extension-sdk'
import { z } from 'zod'

export const EXTENSION_REFERENCE_TOOL = 'nekro_nxt_extension_reference'

const topicList = NEKRO_NXT_EXTENSION_REFERENCE_TOPICS.map(({ id, title }) => `${id}（${title}）`).join('、')

/**
 * The extension authoring reference by topic. The development skill only carries the essentials and the topic list,
 * so an agent reads the interfaces and examples it needs here instead of loading the whole reference.
 */
export const extensionReferenceTool = () =>
  defineTool({
    name: EXTENSION_REFERENCE_TOOL,
    description: `读取扩展开发参考里的主题：接口格式、规则和示例。可以一次读几个。主题有：${topicList}。`,
    parameters: {
      topics: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要读的主题，例如 ["tools", "config"]。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute(args) {
      const input = z.object({ topics: z.array(z.string().trim().min(1)).min(1) }).parse(args)
      const unknown = input.topics.filter((name) => findNekroNxtExtensionReferenceTopic(name) === undefined)
      if (unknown.length > 0) {
        throw new Error(`没有「${unknown.join('」「')}」这个主题。可以读的有：${topicList}。`)
      }
      const ids = new Set(input.topics.map((name) => findNekroNxtExtensionReferenceTopic(name)?.id))
      return Promise.resolve(
        NEKRO_NXT_EXTENSION_REFERENCE_TOPICS.filter(({ id }) => ids.has(id))
          .map(({ id }) => renderNekroNxtExtensionReferenceTopic(id))
          .join('\n\n'),
      )
    },
  })
