import {
  CommandDefinitionSchema,
  CommandResultSchema,
  parseJsonValue,
  type CommandDefinition,
  type CommandDefinitionInput,
  type CommandExecutionContext,
  type CommandHandler,
  type CommandResult,
} from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'

/** Immutable factory registrations, with independently cancellable calls for each agent attachment. */
export class CommandRegistrations {
  #handlers = new Map<string, { definition: CommandDefinition; handler: CommandHandler }>()
  readonly #running = new Map<AbortController, Promise<CommandResult>>()
  #ownsHandlers = true
  #active = true
  #factoryOpen = true
  register = (definition: CommandDefinitionInput, handler: CommandHandler): (() => void) => {
    if (!this.#factoryOpen || !this.#active) throw new Error('registerCommand 必须在扩展 Host factory 阶段调用。')
    const parsed = CommandDefinitionSchema.parse(definition)
    if (typeof handler !== 'function' || this.#handlers.has(parsed.name)) throw new Error('命令重复注册或处理器无效。')
    this.#handlers.set(parsed.name, { definition: parsed, handler })
    return () => {
      this.#handlers.delete(parsed.name)
    }
  }
  seal(declared: readonly CommandDefinition[]): void {
    this.#factoryOpen = false
    if (
      declared.length !== this.#handlers.size ||
      declared.some((d) => {
        const actual = this.#handlers.get(d.name)?.definition
        return (
          actual === undefined ||
          canonicalJson(parseJsonValue(actual)) !== canonicalJson(parseJsonValue(CommandDefinitionSchema.parse(d)))
        )
      })
    )
      throw new Error('Host 实际命令注册与 Manifest 不一致。')
  }
  fork(): CommandRegistrations {
    if (!this.#active || this.#factoryOpen) throw new Error('命令注册尚未完成或扩展已停用。')
    const scope = new CommandRegistrations()
    scope.#handlers = this.#handlers
    scope.#ownsHandlers = false
    scope.#factoryOpen = false
    return scope
  }
  list() {
    if (!this.#active) return []
    return [...this.#handlers.values()].map((entry) => ({
      definition: entry.definition,
      invoke: (context: CommandExecutionContext) => this.#invoke(entry, context),
    }))
  }
  async #invoke(
    entry: { definition: CommandDefinition; handler: CommandHandler },
    context: CommandExecutionContext,
  ): Promise<CommandResult> {
    if (!this.#active || this.#handlers.get(entry.definition.name) !== entry) throw new Error('命令所属扩展已停用。')
    const controller = new AbortController()
    const abort = () => controller.abort(context.signal.reason)
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    const task = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return entry.handler({ ...context, signal: controller.signal })
      })
      .then((value) => CommandResultSchema.parse(value))
    this.#running.set(controller, task)
    try {
      return await task
    } finally {
      context.signal.removeEventListener('abort', abort)
      this.#running.delete(controller)
    }
  }
  async dispose(): Promise<void> {
    this.#active = false
    for (const c of this.#running.keys()) c.abort(new Error('扩展已停用。'))
    await Promise.allSettled(this.#running.values())
    if (this.#ownsHandlers) this.#handlers.clear()
  }
}
