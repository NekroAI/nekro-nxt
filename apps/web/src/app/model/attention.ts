import { useEffect, useSyncExternalStore } from 'react'
import type { AttentionItem as HostAttentionItem } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { useProductRuntime, type ProductRuntime } from '../../product-runtime.js'

export type AttentionSeverity = 'bad' | 'warn' | 'info'

export interface AttentionItem {
  /** Stable fingerprint from the Host; the same problem keeps the same id. */
  readonly id: string
  readonly kind: HostAttentionItem['kind']
  readonly severity: AttentionSeverity
  readonly title: string
  readonly detail: string
  readonly actionLabel: string
  readonly href: string
  readonly outboundId?: string
}

const severity: Record<HostAttentionItem['severity'], AttentionSeverity> = {
  critical: 'bad',
  warning: 'warn',
  info: 'info',
}

function hrefOf(item: HostAttentionItem): string {
  const { related } = item
  switch (item.action.kind) {
    case 'open-channel':
    case 'resolve-delivery':
      return related.channelId ? `/channels/${related.channelId}` : '/channels'
    case 'open-authoring-task':
      return related.taskId ? `/workshop/tasks/${related.taskId}` : '/workshop'
    case 'open-connection':
      return related.connectionId ? `/wiring/connections/${related.connectionId}` : '/wiring'
    case 'open-agent':
      return related.agentId ? `/agents/${related.agentId}` : '/agents'
  }
}

export const toAttentionItem = (item: HostAttentionItem): AttentionItem => ({
  id: item.id,
  kind: item.kind,
  severity: severity[item.severity],
  title: item.title,
  detail: item.detail,
  actionLabel: item.action.label,
  href: hrefOf(item),
  ...(item.related.outboundId ? { outboundId: item.related.outboundId } : {}),
})

/** One shared attention list per runtime: fetched once, refreshed on SSE invalidation and reconnects. */
class AttentionSource {
  #items: readonly AttentionItem[] = []
  #listeners = new Set<() => void>()
  #unsubscribe: (() => void) | undefined
  #pending: Promise<void> | undefined
  #again = false

  constructor(private readonly runtime: ProductRuntime) {}

  get items(): readonly AttentionItem[] {
    return this.#items
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    if (this.#listeners.size === 1) {
      this.#unsubscribe = this.runtime.events.subscribe({
        open: () => void this.refresh(),
        'attention-changed': () => void this.refresh(),
      })
      void this.refresh()
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#unsubscribe?.()
    }
  }

  refresh(): Promise<void> {
    if (this.#pending) {
      this.#again = true
      return this.#pending
    }
    this.#pending = workspaceApi
      .listAttention()
      .then((list) => {
        this.#items = list.items.map(toAttentionItem)
        this.#listeners.forEach((listener) => listener())
      })
      .catch(() => undefined)
      .finally(() => {
        this.#pending = undefined
        if (this.#again) {
          this.#again = false
          void this.refresh()
        }
      })
    return this.#pending
  }

  async dismiss(id: string): Promise<void> {
    this.#items = this.#items.filter((item) => item.id !== id)
    this.#listeners.forEach((listener) => listener())
    await workspaceApi.dismissAttention(id)
  }
}

const sources = new WeakMap<ProductRuntime, AttentionSource>()
export const attentionSource = (runtime: ProductRuntime): AttentionSource => {
  let source = sources.get(runtime)
  if (!source) {
    source = new AttentionSource(runtime)
    sources.set(runtime, source)
  }
  return source
}

export function useAttention(): readonly AttentionItem[] {
  const source = attentionSource(useProductRuntime())
  return useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.items,
  )
}

/** Refresh after local actions that change attention (send, resolve) without waiting for SSE. */
export function useAttentionRefresh(trigger: unknown): void {
  const source = attentionSource(useProductRuntime())
  useEffect(() => {
    void source.refresh()
  }, [source, trigger])
}
