import { createContext, createElement, useContext, type ReactNode } from 'react'
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
    applySnapshot: (snapshot) =>
      store.setState({
        ...snapshot,
        hostUi: snapshot.hostUi ?? { preferencesRevision: 0, pages: [] },
        authoringTasks: snapshot.authoringTasks ?? [],
      }),
  })
  return { host, store, uiStore: createUiStateStore(), events, approvals }
}

export const defaultProductRuntime = createProductRuntime(productHostEventStream)
export type ProductRuntime = ReturnType<typeof createProductRuntime>
const ProductRuntimeContext = createContext<ProductRuntime | null>(null)
export function ProductRuntimeProvider({ runtime, children }: { runtime: ProductRuntime; children: ReactNode }) {
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
