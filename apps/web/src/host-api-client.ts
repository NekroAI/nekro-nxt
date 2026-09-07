import {
  HostApiErrorSchema,
  buildHostApiContractPath,
  type HostApiContract,
  type HostApiContractParams,
  type HostApiContractRequest,
} from '@nekro-nxt/contracts'

export interface HostRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Signals that a read belongs to a disposed runtime; callers must not publish its result or error. */
export class StaleHostReadError extends Error {
  constructor() {
    super('宿主读取已失效。')
    this.name = 'StaleHostReadError'
  }
}

export class HostRequestError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'invalid-response' | 'timeout' | 'aborted',
    message: string,
    readonly status?: number,
    readonly commitState: 'not-applicable' | 'rejected' | 'unknown' = 'not-applicable',
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

/** Owns JSON transport and boundary decoding. Mutations are never automatically retried. */
export async function callHostApi<Contract extends HostApiContract, Output>(
  contract: Contract & { readonly parseResponse: (input: unknown) => Output },
  params: HostApiContractParams<Contract>,
  body: HostApiContractRequest<Contract>,
  options: HostRequestOptions = {},
): Promise<Output> {
  if (options.signal?.aborted) {
    throw new HostRequestError(
      'aborted',
      '服务请求已取消。',
      undefined,
      contract.method === 'GET' ? 'not-applicable' : 'rejected',
    )
  }
  const path = buildHostApiContractPath(contract, params)
  const requestBody = contract.parseRequest(body)
  const serialized = contract.encodeRequest?.(requestBody)
  const mutation = contract.method !== 'GET'
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    options.timeoutMs ?? contract.timeoutMs ?? (mutation ? 60_000 : 30_000),
  )
  try {
    let response: Response
    let json: unknown
    try {
      response = await fetch(path, {
        method: contract.method,
        headers: {
          accept: contract.responseFormat === 'bytes' ? 'application/octet-stream' : 'application/json',
          ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }),
          ...serialized?.headers,
        },
        ...(serialized !== undefined
          ? { body: typeof serialized.body === 'string' ? serialized.body : new Uint8Array(serialized.body) }
          : requestBody === undefined
            ? {}
            : { body: JSON.stringify(requestBody) }),
        signal: controller.signal,
      })
      json =
        response.ok && contract.responseFormat === 'bytes'
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json().catch((cause: unknown) => {
              if (controller.signal.aborted) throw cause
              return null
            })
    } catch (cause) {
      const kind = timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'network'
      const message = timedOut
        ? '服务请求超时。'
        : kind === 'aborted'
          ? '服务请求已取消。'
          : cause instanceof Error
            ? cause.message
            : '无法连接 NekroNXT Host。'
      throw new HostRequestError(
        kind,
        mutation ? `${message} 操作结果未知，请先刷新确认。` : message,
        undefined,
        mutation ? 'unknown' : 'not-applicable',
      )
    }
    if (!response.ok) {
      const error = HostApiErrorSchema.safeParse(json)
      throw new HostRequestError(
        'http',
        error.success ? error.data.error.message : `服务请求失败：${response.status}`,
        response.status,
        mutation ? (response.status >= 500 ? 'unknown' : 'rejected') : 'not-applicable',
      )
    }
    try {
      const decode: (input: unknown) => Output = contract.parseResponse
      return decode(json)
    } catch (cause) {
      throw new HostRequestError(
        'invalid-response',
        `NekroNXT Host 返回的数据格式无效：${cause instanceof Error ? cause.message : String(cause)}`,
        response.status,
        mutation ? 'unknown' : 'not-applicable',
      )
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
