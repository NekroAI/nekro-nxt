import { StaleHostReadError } from './host-api-client.js'

export interface HostQueryState<T> {
  readonly data: T | undefined
  readonly loading: boolean
  readonly error: string
}

/** Owns requests only; the supplied Store is the sole owner of query data. */
export function createOwnedHostQuery<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (patch: Partial<HostQueryState<T>>) => void,
) {
  let generation = 0
  let controller: AbortController | undefined
  let pending: Promise<T> | undefined
  let again = false
  const cancel = (): void => {
    generation += 1
    controller?.abort()
    pending = undefined
    again = false
    publish({ loading: false })
  }
  const load = (invalidate = false): Promise<T> => {
    if (pending) {
      again ||= invalidate
      return pending
    }
    const current = generation
    controller = new AbortController()
    const signal = controller.signal
    publish({ loading: true, error: '' })
    const request = (async () => {
      try {
        let data: T
        do {
          again = false
          data = await Promise.resolve().then(() => read(signal))
          if (current !== generation) throw new StaleHostReadError()
          publish({ data })
        } while (again)
        return data
      } catch (cause) {
        if (current !== generation) throw new StaleHostReadError()
        if (!(cause instanceof StaleHostReadError)) {
          publish({ error: cause instanceof Error ? cause.message : String(cause) })
        }
        throw cause
      } finally {
        if (current === generation) {
          pending = undefined
          publish({ loading: false })
        }
      }
    })()
    pending = request
    return request
  }
  return {
    load,
    cancel,
    replace(data: T): void {
      cancel()
      publish({ data, error: '' })
    },
  }
}
