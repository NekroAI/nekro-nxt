import type { AdapterFailureKind } from '@nekro-nxt/adapter-sdk'

export type QQTransportFailureKind = AdapterFailureKind | 'unknown'

/** A redacted transport failure whose classification is safe to persist in Delivery receipts. */
export class QQTransportError extends Error {
  readonly kind: QQTransportFailureKind
  readonly retryAfterMs: number | undefined

  constructor(
    kind: QQTransportFailureKind,
    message: string,
    options: { readonly retryAfterMs?: number; readonly cause?: unknown } = {},
  ) {
    super(message.slice(0, 512), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'QQTransportError'
    this.kind = kind
    this.retryAfterMs = options.retryAfterMs
  }
}

export const isQQTransportError = (error: unknown): error is QQTransportError => error instanceof QQTransportError
