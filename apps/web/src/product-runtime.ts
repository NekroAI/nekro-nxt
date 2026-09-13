import { setUnsavedDraftOwner } from './unsaved-drafts.js'
import { createContext, createElement, useContext, useEffect, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { ProductState } from './product-model.js'
import type { UiState } from './ui-state.js'
import { createDynamicClientApprovalBridge } from './dynamic-client-bridge.js'
import { createUiStateStore } from './ui-state.js'
import { HttpProductHost } from './http-host.js'
import { HostEventStream, productHostEventStream } from './host-event-stream.js'
import { createProductStore } from './product-store.js'
export * from './product-model.js'

/** Each instance owns its data and transport. Product actions close over this host, never a replaceable global. */
export function createProductRuntime(events = new HostEventStream()) {
  const uiStore = createUiStateStore()
  const approvals = createDynamicClientApprovalBridge()
  const store = createProductStore(() => host, approvals)
  const host = new HttpProductHost(events, {
    getSnapshot: store.getState,
    resetLoads: () => {
      store.getState().cancelPlatformUserDirectory()
      store.getState().cancelSettingsQueries()
      store.setState((state) => ({
        channelHistory: Object.fromEntries(
          Object.entries(state.channelHistory).map(([id, page]) => [
            id,
            { ...page, loading: false, loadingMore: false },
          ]),
        ),
        connections: state.connections.map((connection) => ({ ...connection, eventsLoading: false })),
      }))
    },
    applySnapshot: (snapshot) => {
      const liveIds =
        snapshot.host.status === 'ready' ? new Set(snapshot.channels.map((channel) => channel.id)) : undefined
      if (liveIds) uiStore.getState().retainChannelDrafts(liveIds)
      const history = store.getState().channelHistory
      const channelHistory =
        liveIds && Object.keys(history).some((id) => !liveIds.has(id))
          ? Object.fromEntries(Object.entries(history).filter(([id]) => liveIds.has(id)))
          : history
      store.setState({
        channelHistory,
        ...snapshot,
        hostUi: snapshot.hostUi ?? { preferencesRevision: 0, pages: [] },
        authoringTasks: snapshot.authoringTasks ?? [],
      })
    },
  })
  return { host, store, uiStore, events, approvals }
}

export const defaultProductRuntime = createProductRuntime(productHostEventStream)
export type ProductRuntime = ReturnType<typeof createProductRuntime>
const ProductRuntimeContext = createContext<ProductRuntime | null>(null)
export function ProductRuntimeProvider({ runtime, children }: { runtime: ProductRuntime; children: ReactNode }) {
  useEffect(() => {
    const owner = Symbol('channel-drafts')
    const update = () =>
      setUnsavedDraftOwner(
        owner,
        Object.values(runtime.uiStore.getState().channelDrafts).some((draft) => Boolean(draft.text.trim())),
      )
    update()
    const unsubscribe = runtime.uiStore.subscribe(update)
    return () => {
      unsubscribe()
      setUnsavedDraftOwner(owner, false)
    }
  }, [runtime])
  return createElement(ProductRuntimeContext.Provider, { value: runtime }, children)
}
export function useProductRuntime(): ProductRuntime {
  return useContext(ProductRuntimeContext) ?? defaultProductRuntime
}
export function useProductStore<T>(selector: (state: ProductState) => T): T {
  return useStore(useProductRuntime().store, selector)
}
export function useUiStateStore<T>(selector: (state: UiState) => T): T {
  return useStore(useProductRuntime().uiStore, selector)
}
export function useHostActions() {
  return useProductRuntime().host.actions
}
