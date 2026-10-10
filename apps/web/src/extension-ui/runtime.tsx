import type { ExtensionUiContributions, HostUiPermission } from '@nekro-nxt/contracts'
import type { ExtensionClientHost } from '@nekro-nxt/extension-sdk'
import { createLibraryHost } from './library-host.js'
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useProductRuntime, type LocalExtensionSummary, type ProductRuntime } from '../product-runtime.js'
import { mountClient, type MountedClient } from './client.js'
import { ContributionRegistry, type ContributionOwner } from './registry.js'

interface DesiredClient {
  readonly owner: ContributionOwner
  readonly moduleUrl: string
  readonly cssUrl: string
  readonly declared: ExtensionUiContributions
  readonly permissions: readonly HostUiPermission[]
  readonly host: ExtensionClientHost
}

const hasUi = (ui: ExtensionUiContributions): boolean =>
  ui.panels.length > 0 || ui.toolViews.length > 0 || ui.messageRenderers.length > 0

const ADAPTER_PREFIX = '适配器：'

/**
 * Installed Clients the shell should run: one per installed extension with UI, on its installed record. Its panels
 * and tool views are placed for the agents it is enabled for when rendering, so enabling never remounts it.
 */
const desiredClients = (product: ProductRuntime, extensions: readonly LocalExtensionSummary[]): DesiredClient[] =>
  extensions.flatMap((extension): DesiredClient[] => {
    const installed = extension.installation
    if (!installed) return []
    const revision = extension.revisions.find((candidate) => candidate.id === installed.revisionId)
    if (!revision?.buildKey || revision.format === 'unavailable' || !hasUi(revision.ui)) return []
    const buildKey = revision.buildKey
    const adapterKey = revision.contributions
      .find((entry) => entry.startsWith(ADAPTER_PREFIX))
      ?.slice(ADAPTER_PREFIX.length)
    const path = `/api/extensions/${encodeURIComponent(extension.id)}/revisions/${encodeURIComponent(revision.id)}/client/${buildKey}`
    return [
      {
        owner: {
          kind: 'extension',
          key: `extension:${extension.id}`,
          label: extension.name,
          extensionId: extension.id,
          revisionId: revision.id,
          ...(adapterKey === undefined ? {} : { adapterKey }),
          styleScope: buildKey,
        },
        moduleUrl: `${path}.mjs`,
        cssUrl: `${path}.css`,
        declared: revision.ui,
        permissions: revision.verification?.permissions?.permissions ?? [],
        host: {
          call: (method, input, options) =>
            product.store.getState().callExtensionClient({
              extensionId: extension.id,
              revisionId: revision.id,
              ...(options?.anchor === undefined ? {} : { anchor: options.anchor }),
              method,
              ...(input === undefined ? {} : { value: input }),
            }),
          subscribe: () => () => undefined,
          ...createLibraryHost(extension.id),
        },
      },
    ]
  })

const clientIdentity = (client: DesiredClient): string => `${client.moduleUrl}\0${client.permissions.join(',')}`

/**
 * The one browser runtime for installed extension UI. It mounts each owner's Client once, keeps them in a shared
 * registry, isolates failures per owner and reports load results back to the Host.
 */
export class ExtensionUiRuntime {
  readonly registry = new ContributionRegistry()
  readonly #product: ProductRuntime
  readonly #mounted = new Map<string, { readonly identity: string; readonly handle: MountedClient }>()
  readonly #failures = new Map<string, string>()
  readonly #listeners = new Set<() => void>()
  #desired: readonly DesiredClient[] = []
  #queue: Promise<void> = Promise.resolve()
  #version = 0
  #disposed = false

  constructor(product: ProductRuntime) {
    this.#product = product
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  version = (): number => this.#version

  /** Why an owner's Client is not running, if it failed. */
  failure(ownerKey: string): string | undefined {
    return this.#failures.get(ownerKey)
  }

  sync(extensions: readonly LocalExtensionSummary[]): Promise<void> {
    this.#desired = desiredClients(this.#product, extensions)
    return this.#enqueue(() => this.#reconcile())
  }

  /** Remounts one owner after a failure, from the latest Host state. */
  reload(ownerKey: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#unmount(ownerKey)
      this.#failures.delete(ownerKey)
      await this.#reconcile()
    })
  }

  /** A contribution threw while rendering: record it for the owner; its other contributions keep running. */
  reportRenderFailure(owner: ContributionOwner, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (this.#failures.get(owner.key) === message) return
    this.#failures.set(owner.key, message)
    void this.#report(owner, 'failed', message)
    this.#publish()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#queue.catch(() => undefined)
    await Promise.allSettled([...this.#mounted.keys()].map((key) => this.#unmount(key)))
    this.#publish()
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed) return
    const desired = new Map(this.#desired.map((client) => [client.owner.key, client]))
    for (const [key, mounted] of [...this.#mounted]) {
      const next = desired.get(key)
      if (next && clientIdentity(next) === mounted.identity) continue
      await this.#unmount(key)
    }
    for (const failed of [...this.#failures.keys()]) if (!desired.has(failed)) this.#failures.delete(failed)
    for (const client of desired.values()) {
      if (this.#mounted.has(client.owner.key) || this.#failures.has(client.owner.key)) continue
      try {
        const handle = await mountClient({
          owner: client.owner,
          moduleUrl: client.moduleUrl,
          cssUrl: client.cssUrl,
          declared: client.declared,
          permissions: client.permissions,
          host: client.host,
          registry: this.registry,
          store: this.#product.store,
        })
        if (this.#disposed) {
          await handle.dispose()
          return
        }
        this.#mounted.set(client.owner.key, { identity: clientIdentity(client), handle })
        void this.#report(client.owner, 'loaded')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#failures.set(client.owner.key, message)
        void this.#report(client.owner, 'failed', message)
      }
    }
    this.#publish()
  }

  async #unmount(ownerKey: string): Promise<void> {
    const mounted = this.#mounted.get(ownerKey)
    if (!mounted) return
    this.#mounted.delete(ownerKey)
    await mounted.handle.dispose().catch(() => undefined)
  }

  async #report(owner: ContributionOwner, status: 'loaded' | 'failed', message?: string): Promise<void> {
    const store = this.#product.store.getState()
    const detail = message === undefined ? {} : { message: message.slice(0, 4096) }
    if (owner.kind === 'extension') {
      await store
        .reportHostExtensionClientDiagnostic({
          extensionId: owner.extensionId,
          revisionId: owner.revisionId,
          status,
          ...detail,
        })
        .catch(() => undefined)
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.catch(() => undefined)
    return next
  }

  #publish(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

const ExtensionUiContext = createContext<ExtensionUiRuntime | null>(null)

/** Mounts installed extension UI for the whole session; place once near the root of the shell. */
export function ExtensionUiProvider({ children }: { readonly children: ReactNode }) {
  const product = useProductRuntime()
  const runtime = useMemo(() => new ExtensionUiRuntime(product), [product])
  const disposeTimer = useRef<number | undefined>(undefined)
  const extensions = useSyncExternalStore(
    product.store.subscribe,
    () => product.store.getState().extensions,
    () => product.store.getState().extensions,
  )
  useEffect(() => {
    if (disposeTimer.current !== undefined) window.clearTimeout(disposeTimer.current)
    void runtime.sync(extensions)
  }, [extensions, runtime])
  useEffect(
    () => () => {
      // StrictMode remounts effects immediately; dispose only when the provider really goes away.
      disposeTimer.current = window.setTimeout(() => void runtime.dispose(), 0)
    },
    [runtime],
  )
  return <ExtensionUiContext.Provider value={runtime}>{children}</ExtensionUiContext.Provider>
}

/** The installed-extension runtime, or `undefined` outside the provider (contributions then render nothing). */
export function useExtensionUiRuntime(): ExtensionUiRuntime | undefined {
  const runtime = useContext(ExtensionUiContext) ?? undefined
  useSyncExternalStore(runtime?.subscribe ?? noopSubscribe, runtime?.version ?? zero, runtime?.version ?? zero)
  return runtime
}

const noopSubscribe = (): (() => void) => () => undefined
const zero = (): number => 0
