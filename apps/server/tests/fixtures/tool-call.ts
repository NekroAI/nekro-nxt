import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Run one tool call through the selected executor outside any model step (no Session log) and return its settled
 * result. The context needs `dsh-tools` and an executor, e.g. `@deepseek-ai/dsh-tool-executor-native`.
 */
export const executeToolCall = async (
  context: Context,
  input: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal?: AbortSignal
    readonly agent?: Agent
  },
): Promise<ToolExecutionResult> => {
  const batch = await context.tools.execute({
    calls: [
      { type: 'tool-call', id: ToolCallId(input.callId), name: input.name, arguments: JSON.stringify(input.arguments) },
    ],
    signal: input.signal ?? new AbortController().signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  })
  const settled = batch.results[0]
  if (settled === undefined) throw new Error(`Tool call ${input.callId} did not settle.`)
  return settled.result
}
