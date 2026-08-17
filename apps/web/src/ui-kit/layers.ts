import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

export interface ModalLayer {
  readonly order: number
  readonly overlay: number
  readonly content: number
  readonly floating: number
}

export interface ModalLayerRegistryOptions {
  readonly modalBase?: number
  readonly modalStep?: number
  readonly floatingBase?: number
}

/**
 * Modal layers are allocated in groups. The group step is deliberately wider
 * than one modal's overlay/content/floating range, so a newer overlay always
 * covers every floating surface owned by an older modal.
 */
export class ModalLayerRegistry {
  readonly #modalBase: number
  readonly #modalStep: number
  readonly #floatingBase: number
  readonly #entries: string[] = []
  readonly #listeners = new Set<() => void>()
  #version = 0

  constructor({ modalBase = 80, modalStep = 4, floatingBase = 60 }: ModalLayerRegistryOptions = {}) {
    if (modalStep < 3) throw new Error('Modal layer step must reserve overlay, content, and floating layers.')
    this.#modalBase = modalBase
    this.#modalStep = modalStep
    this.#floatingBase = floatingBase
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): number => this.#version

  register(id: string): () => void {
    if (!this.#entries.includes(id)) {
      this.#entries.push(id)
      this.#publish()
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.#entries.indexOf(id)
      if (index === -1) return
      this.#entries.splice(index, 1)
      this.#publish()
    }
  }

  layerFor(id: string): ModalLayer | undefined {
    const order = this.#entries.indexOf(id)
    return order === -1 ? undefined : this.#layerAt(order)
  }

  previewNextLayer(): ModalLayer {
    return this.#layerAt(this.#entries.length)
  }

  topFloatingLayer(): number {
    return this.#entries.length === 0 ? this.#floatingBase : this.#layerAt(this.#entries.length - 1).floating
  }

  get size(): number {
    return this.#entries.length
  }

  #layerAt(order: number): ModalLayer {
    const overlay = this.#modalBase + order * this.#modalStep
    return { order, overlay, content: overlay + 1, floating: overlay + 2 }
  }

  #publish(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

export const modalLayerRegistry = new ModalLayerRegistry()
export const MODAL_LAYER_RELEASE_DELAY_MS = 240

const useSafeLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

export function useModalLayer(open: boolean): ModalLayer {
  const id = useId()
  const unregisterRef = useRef<(() => void) | undefined>(undefined)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useSyncExternalStore(modalLayerRegistry.subscribe, modalLayerRegistry.getSnapshot, modalLayerRegistry.getSnapshot)

  useSafeLayoutEffect(() => {
    if (open) {
      if (releaseTimerRef.current !== undefined) clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = undefined
      unregisterRef.current ??= modalLayerRegistry.register(id)
      return
    }
    if (unregisterRef.current && releaseTimerRef.current === undefined) {
      releaseTimerRef.current = setTimeout(() => {
        unregisterRef.current?.()
        unregisterRef.current = undefined
        releaseTimerRef.current = undefined
      }, MODAL_LAYER_RELEASE_DELAY_MS)
    }
  }, [id, open])

  useSafeLayoutEffect(
    () => () => {
      if (releaseTimerRef.current !== undefined) clearTimeout(releaseTimerRef.current)
      unregisterRef.current?.()
      unregisterRef.current = undefined
      releaseTimerRef.current = undefined
    },
    [id],
  )

  return modalLayerRegistry.layerFor(id) ?? modalLayerRegistry.previewNextLayer()
}

export function useFloatingLayer(): number {
  useSyncExternalStore(modalLayerRegistry.subscribe, modalLayerRegistry.getSnapshot, modalLayerRegistry.getSnapshot)
  return modalLayerRegistry.topFloatingLayer()
}
