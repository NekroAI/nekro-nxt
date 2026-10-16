import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@nekro-nxt/contracts'

/** The model route of sub-conversations the host runs by script; it never leaves this process. */
export const CONVERSATION_SCRIPT_PROVIDER = 'nekro-nxt-script'

/** The tool calls a scripted sub-conversation makes, one per step, and the line it ends with. */
export interface ConversationScript {
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: JsonValue }[]
  readonly closing: string
}

/**
 * A local model that plays a script instead of thinking. DSH only runs tools inside a turn, and only a model starts
 * turns; a host that needs tools run in a conversation of its own (verifying a candidate) gives that conversation
 * this model, so every call goes through the normal tool pipeline and lands in a well-formed turn of its own log.
 */
export class ConversationScriptModel extends LlmAdapter {
  readonly #scripts = new Map<string, ConversationScript>()

  /** Makes `script` the model `model`; the returned function removes it. */
  load(model: string, script: ConversationScript): () => void {
    if (this.#scripts.has(model)) throw new Error(`脚本对话 ${model} 已经在运行。`)
    this.#scripts.set(model, script)
    return () => this.#scripts.delete(model)
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'NekroNXT 脚本' }
  }

  override listModels() {
    // Scripts are not offered as models anyone can choose.
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const script = this.#scripts.get(options.model)
    if (script === undefined) throw new Error(`没有找到脚本对话 ${options.model}。`)
    const done = options.messages.filter((message) => message.role === 'tool').length
    const call = script.calls[done]
    if (call !== undefined) {
      const id = ToolCallId(call.id)
      const argumentsText = JSON.stringify(call.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: script.closing }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: script.closing } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
