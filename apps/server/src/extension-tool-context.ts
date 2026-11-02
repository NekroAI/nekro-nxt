import { EXTENSION_FILES_SDK_LEVEL } from '@nekro-nxt/contracts'
import type {
  ExtensionJsonObject,
  ExtensionJsonValue,
  ExtensionToolDefinition,
  ExtensionToolExecutionContext,
  ExtensionToolProgress,
} from '@nekro-nxt/extension-sdk'

/** Longest time limit an extension Tool may declare (附加功能 F12). */
export const EXTENSION_TOOL_MAX_TIMEOUT_SECONDS = 900

/** What DSH hands a Tool body; only the parts an extension Tool context needs. */
export interface DshToolExecution {
  readonly callId?: string
  readonly signal?: AbortSignal
}

/** Receives the progress a running extension Tool reports for one call. */
export type ToolProgressSink = (callId: string, update: ExtensionToolProgress) => void

/** A compiled extension Tool as DSH runs it: the second `execute` argument is DSH's own execution. */
export type DshBoundTool = Omit<ExtensionToolDefinition, 'execute'> & {
  readonly timeoutMs?: number
  execute(args: ExtensionJsonObject, exec?: DshToolExecution): ExtensionJsonValue | Promise<ExtensionJsonValue>
}

/**
 * DSH `timeoutMs` for a declared `timeoutSeconds`; undefined keeps the agent's default limit. Throws for an invalid
 * value or a Revision older than SDK 14, so the author sees it when the Tool registers.
 */
export const extensionToolTimeoutMs = (
  tool: Pick<ExtensionToolDefinition, 'name' | 'timeoutSeconds'>,
  sdk: number | undefined,
): number | undefined => {
  const seconds = tool.timeoutSeconds
  if (seconds === undefined) return undefined
  if (sdk !== undefined && sdk < EXTENSION_FILES_SDK_LEVEL) {
    throw new Error(
      `工具 ${tool.name} 声明了 timeoutSeconds，需要在清单中声明 requires.sdk 为 ${EXTENSION_FILES_SDK_LEVEL} 或更高。`,
    )
  }
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > EXTENSION_TOOL_MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `工具 ${tool.name} 的 timeoutSeconds 必须是 1 到 ${EXTENSION_TOOL_MAX_TIMEOUT_SECONDS} 之间的整数。`,
    )
  }
  return seconds * 1000
}

const idleSignal = (): AbortSignal => new AbortController().signal

/** The context an extension Tool body receives: the call's cancellation and a progress reporter. */
export const extensionToolContext = (
  exec: DshToolExecution | undefined,
  progress: ToolProgressSink | undefined,
): ExtensionToolExecutionContext => {
  const callId = exec?.callId
  return {
    signal: exec?.signal ?? idleSignal(),
    progress: (update) => {
      if (callId !== undefined) progress?.(callId, update)
    },
  }
}

/**
 * Binds a compiled extension Tool to DSH: `timeoutSeconds` becomes DSH's `timeoutMs`, and the body receives
 * `{ signal, progress }` instead of DSH's execution. `sdk` is the Revision's `requires.sdk`; dynamic runs pass
 * undefined.
 */
export const bindExtensionTool = (
  tool: ExtensionToolDefinition,
  options: { readonly sdk?: number | undefined; readonly progress?: ToolProgressSink | undefined },
): DshBoundTool => {
  const timeoutMs = extensionToolTimeoutMs(tool, options.sdk)
  return {
    ...tool,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // A defined Tool's `execute` validates the arguments and passes this context on to the author's body.
    execute: async (args, exec) => tool.execute(args, extensionToolContext(exec, options.progress)),
  }
}
