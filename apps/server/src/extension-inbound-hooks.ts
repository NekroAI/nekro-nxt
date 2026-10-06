import type { InboundHookDecision, InboundHookGate } from '@nekro-nxt/channel-runtime'
import type { BindingRecord, ChannelEventRecord } from '@nekro-nxt/core'
import type { AgentId, ChannelEventId, ExtensionCapabilities } from '@nekro-nxt/contracts'
import type { NxtHostService, NxtInboundDecision, NxtInboundMessage } from '@nekro-nxt/extension-sdk'
import type { PersistentInboundHandler } from './persistent-extension-mounts.js'

export const INBOUND_ANNOTATION_MAX_CHARS = 500

/** Durable decision store; a saved decision is never rewritten. */
export interface InboundHookDecisionStore {
  get(eventId: ChannelEventId, agentId: AgentId): InboundHookDecision | undefined
  save(input: {
    readonly eventId: ChannelEventId
    readonly agentId: AgentId
    readonly decision: InboundHookDecision
    readonly decidedBy: readonly string[]
    readonly diagnostics: readonly { readonly extensionId: string; readonly message: string }[]
    readonly decidedAt: number
  }): InboundHookDecision
}

export interface ExtensionInboundHookGateOptions {
  readonly handlers: (agentId: AgentId) => readonly PersistentInboundHandler[]
  readonly describe: (handler: PersistentInboundHandler) => {
    readonly displayName: string
    readonly capabilities: ExtensionCapabilities | undefined
  }
  /** `nxt` bound to the message's channel for one handler; no prompt registration. */
  readonly nxtFor: (handler: PersistentInboundHandler, channelId: string) => NxtHostService
  readonly message: (event: ChannelEventRecord, defaultTriggered: boolean) => NxtInboundMessage
  readonly store: InboundHookDecisionStore
  readonly now: () => number
  readonly diagnostic?: (extensionId: string, message: string) => void
}

const timeout = <Value>(promise: Promise<Value>, ms: number): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`入站处理超过 ${ms}ms，按默认处理。`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Rank used to merge several extensions: the most restrictive answer wins. */
const TRIGGER_RANK = { suppress: 2, force: 1, default: 0 } as const

/**
 * Inbound hooks of agent extensions. Each handler sees only what its declaration allows, runs under its own timeout,
 * and may only exercise the effects it declared; failures fall back to the default and are recorded, never thrown.
 */
export class ExtensionInboundHookGate implements InboundHookGate {
  readonly #options: ExtensionInboundHookGateOptions
  readonly #pending = new Map<string, Promise<InboundHookDecision>>()

  constructor(options: ExtensionInboundHookGateOptions) {
    this.#options = options
  }

  covers(agentId: AgentId): boolean {
    return this.#options.handlers(agentId).length > 0
  }

  stored(eventId: ChannelEventId, agentId: AgentId): InboundHookDecision | undefined {
    return this.#options.store.get(eventId, agentId)
  }

  decide(input: {
    readonly binding: BindingRecord
    readonly event: ChannelEventRecord
    readonly defaultTriggered: boolean
  }): Promise<InboundHookDecision> {
    const key = `${input.event.id}\0${input.binding.agentId}`
    const stored = this.stored(input.event.id, input.binding.agentId)
    if (stored !== undefined) return Promise.resolve(stored)
    const pending = this.#pending.get(key)
    if (pending !== undefined) return pending
    const deciding = this.#decide(input).finally(() => this.#pending.delete(key))
    this.#pending.set(key, deciding)
    return deciding
  }

  async #decide(input: {
    readonly binding: BindingRecord
    readonly event: ChannelEventRecord
    readonly defaultTriggered: boolean
  }): Promise<InboundHookDecision> {
    const message = this.#options.message(input.event, input.defaultTriggered)
    const decidedBy: string[] = []
    const diagnostics: { extensionId: string; message: string }[] = []
    let trigger: InboundHookDecision['trigger'] = 'default'
    let hidden = false
    const annotations: string[] = []
    for (const handler of this.#options.handlers(input.binding.agentId)) {
      const extensionId = handler.revision.extensionId
      const { capabilities, displayName } = this.#options.describe(handler)
      const declared = capabilities?.inboundHook
      if (declared === undefined) continue
      if (declared.reads === 'triggered' && !input.defaultTriggered) continue
      let answer: NxtInboundDecision | undefined
      try {
        answer = await timeout(
          Promise.resolve(handler.handler(message, this.#options.nxtFor(handler, input.event.channelId))),
          declared.timeoutMs,
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        diagnostics.push({ extensionId, message: reason })
        this.#options.diagnostic?.(extensionId, reason)
        continue
      }
      decidedBy.push(extensionId)
      if (answer === undefined || answer === null || typeof answer !== 'object') continue
      const wanted = answer.trigger ?? 'default'
      const allowed = wanted === 'force' && !declared.mayForceTrigger ? 'default' : wanted
      if (allowed !== wanted) diagnostics.push({ extensionId, message: '未声明 mayForceTrigger，忽略强制触发。' })
      if (TRIGGER_RANK[allowed] > TRIGGER_RANK[trigger]) trigger = allowed
      if (answer.hideFromAgent === true) {
        if (declared.mayHide) hidden = true
        else diagnostics.push({ extensionId, message: '未声明 mayHide，忽略隐藏。' })
      }
      if (typeof answer.annotation === 'string' && answer.annotation.trim() !== '') {
        annotations.push(`${displayName}：${answer.annotation.trim().slice(0, INBOUND_ANNOTATION_MAX_CHARS)}`)
      }
    }
    const annotation = annotations.join('\n')
    return this.#options.store.save({
      eventId: input.event.id,
      agentId: input.binding.agentId,
      decision: { trigger, hidden, ...(annotation === '' ? {} : { annotation }) },
      decidedBy,
      diagnostics,
      decidedAt: this.#options.now(),
    })
  }
}

/** In-process store used until a durable one is wired, and by tests. */
export const memoryInboundHookDecisionStore = (): InboundHookDecisionStore => {
  const decisions = new Map<string, InboundHookDecision>()
  return {
    get: (eventId, agentId) => decisions.get(`${eventId}\0${agentId}`),
    save: ({ eventId, agentId, decision }) => {
      const key = `${eventId}\0${agentId}`
      const existing = decisions.get(key)
      if (existing !== undefined) return existing
      decisions.set(key, decision)
      return decision
    },
  }
}
