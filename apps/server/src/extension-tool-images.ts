import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionToolDefinition,
  ExtensionToolResultBlock,
} from '@nekro-nxt/extension-sdk'

/** At most this many pictures per tool result; the rest are named in text. */
export const TOOL_RESULT_MAX_IMAGES = 6

export type ToolImagePlan =
  /** Shown to the model now. */
  | { readonly state: 'shown'; readonly attachment: ImageAttachmentRef }
  /** Already in the model's context; repeating it would only cost tokens. */
  | { readonly state: 'visible' }
  /** The model has no vision, or the picture cannot be read. */
  | { readonly state: 'text'; readonly reason: string }

/** Decides, for one Session, how each picture of a tool result reaches the model. */
export interface ToolImageResolver {
  plan(
    images: readonly { readonly assetId: string; readonly label?: string }[],
    agent: Agent | undefined,
  ): Promise<readonly ToolImagePlan[]>
}

/** An extension Tool whose rendered result may carry pictures for the model. */
export type ImageAwareTool = Omit<ExtensionToolDefinition, 'output' | 'execute'> & {
  readonly output: {
    readonly schema: ExtensionToolDefinition['output']['schema']
    render(args: ExtensionJsonObject, value: ExtensionJsonValue): readonly (ExtensionToolResultBlock | ContentBlock)[]
  }
  execute(args: ExtensionJsonObject, exec?: { readonly agent?: Agent }): Promise<ExtensionJsonValue>
}

const resultKey = (toolName: string, args: unknown, value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([toolName, args, value]))
    .digest('hex')

/**
 * Wraps an extension Tool so `{ type: 'image', assetId }` blocks of its result become pictures in the model context.
 *
 * The Tool's value is left untouched (scripts in programmatic mode read it as-is), so the plan is computed in
 * `execute`, where the Session is known, and kept briefly for the synchronous `render` that follows.
 */
export const withToolImages = (tool: ExtensionToolDefinition, resolver: ToolImageResolver): ImageAwareTool => {
  const plans = new Map<string, readonly ToolImagePlan[]>()
  return {
    ...tool,
    output: {
      schema: tool.output.schema,
      render: (args, value) => {
        const blocks = tool.output.render(args, value)
        if (!blocks.some((block) => block.type === 'image')) return blocks
        const key = resultKey(tool.name, args, value)
        const plan = plans.get(key)
        plans.delete(key)
        let imageIndex = 0
        const content: (ExtensionToolResultBlock | ContentBlock)[] = []
        for (const block of blocks) {
          if (block.type !== 'image') {
            content.push(block)
            continue
          }
          const label = block.label?.trim() || `图片 ${block.assetId}`
          const step = plan?.[imageIndex++]
          if (step?.state === 'shown') {
            content.push({ type: 'text', text: label })
            content.push({ type: 'image', attachment: step.attachment })
          } else if (step?.state === 'visible') {
            content.push({ type: 'text', text: `${label}（上文已经给你看过）` })
          } else {
            content.push({ type: 'text', text: `${label}（${step?.reason ?? '这次没有附上图片'}）` })
          }
        }
        return content
      },
    },
    async execute(args, exec) {
      const value = await tool.execute(args)
      const images = tool.output
        .render(args, value)
        .flatMap((block) =>
          block.type === 'image'
            ? [{ assetId: block.assetId, ...(block.label === undefined ? {} : { label: block.label }) }]
            : [],
        )
      if (images.length > 0) {
        const planned = await resolver.plan(images.slice(0, TOOL_RESULT_MAX_IMAGES), exec?.agent)
        const overflow = images.slice(TOOL_RESULT_MAX_IMAGES).map(() => ({
          state: 'text' as const,
          reason: `一次最多附 ${TOOL_RESULT_MAX_IMAGES} 张图`,
        }))
        plans.set(resultKey(tool.name, args, value), [...planned, ...overflow])
        // Render follows execute immediately; a plan the runtime never rendered must not accumulate.
        while (plans.size > 64) plans.delete(plans.keys().next().value!)
      }
      return value
    },
  }
}
