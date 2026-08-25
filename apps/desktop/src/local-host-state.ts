import type { InstanceStatus } from './instance-profiles.js'

export type LocalHostStatus = Extract<InstanceStatus, 'connecting' | 'ready' | 'unstable' | 'offline'>

export type LocalHostLifecycleEvent = 'initial-ready' | 'restarting' | 'recovered' | 'fatal'

export const localHostStatusForLifecycleEvent = (event: LocalHostLifecycleEvent): LocalHostStatus => {
  switch (event) {
    case 'initial-ready':
    case 'recovered':
      return 'ready'
    case 'restarting':
      return 'unstable'
    case 'fatal':
      return 'offline'
  }
}

/** Retains the latest Host lifecycle commit while the Desktop manager is being constructed or disposed. */
export class LocalHostLifecycleRelay {
  #status: LocalHostStatus = 'connecting'
  #subscriber: ((status: LocalHostStatus) => void) | undefined

  get status(): LocalHostStatus {
    return this.#status
  }

  commit(event: LocalHostLifecycleEvent): void {
    const status = localHostStatusForLifecycleEvent(event)
    if (status === this.#status) return
    this.#status = status
    this.#subscriber?.(status)
  }

  subscribe(subscriber: (status: LocalHostStatus) => void): () => void {
    this.#subscriber = subscriber
    subscriber(this.#status)
    return () => {
      if (this.#subscriber === subscriber) this.#subscriber = undefined
    }
  }
}
