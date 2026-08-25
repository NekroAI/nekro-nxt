export const trustedInstanceErrorCodes = [
  'invalid-address',
  'unsupported-protocol',
  'duplicate-instance',
  'management-key-required',
  'management-key-rejected',
  'authentication-required',
  'unreachable',
  'incompatible-instance',
  'transport-mismatch',
  'instance-identity-changed',
  'tls-identity-changed',
  'unsafe-redirect',
  'insecure-http-confirmation-required',
  'operation-failed',
] as const
export type TrustedInstanceErrorCode = (typeof trustedInstanceErrorCodes)[number]

export interface TrustedInstanceError {
  readonly code: TrustedInstanceErrorCode
  readonly message: string
}

export type TrustedInstanceIpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TrustedInstanceError }

export type TrustedInstanceInvoker = (channel: string, payload?: unknown) => Promise<unknown>

export class InstanceOperationError extends Error {
  readonly code: TrustedInstanceErrorCode

  constructor(code: TrustedInstanceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InstanceOperationError'
    this.code = code
  }
}

const networkErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
])

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined
  return typeof cause.code === 'string' ? cause.code : undefined
}

export const toTrustedInstanceError = (cause: unknown): TrustedInstanceError => {
  if (cause instanceof InstanceOperationError) return { code: cause.code, message: cause.message }
  if (networkErrorCodes.has(errorCode(cause) ?? '')) {
    return { code: 'unreachable', message: '无法连接服务器，请检查地址、端口和网络状态。' }
  }
  return { code: 'operation-failed', message: '无法完成实例操作，请稍后重试。' }
}

export const trustedInstanceSuccess = <T>(value: T): TrustedInstanceIpcResult<T> => ({ ok: true, value })

export const trustedInstanceFailure = (cause: unknown): TrustedInstanceIpcResult<never> => ({
  ok: false,
  error: toTrustedInstanceError(cause),
})

const isTrustedResult = (value: unknown): value is TrustedInstanceIpcResult<unknown> => {
  if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return 'value' in value
  return (
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error &&
    typeof value.error.code === 'string' &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  )
}

export const invokeTrustedInstanceOperation = async (
  invoke: TrustedInstanceInvoker,
  action: string,
  payload?: unknown,
): Promise<unknown> => {
  let result: unknown
  try {
    result = await invoke(`nxt:instances:${action}`, payload)
  } catch {
    throw new Error('无法完成实例操作，请稍后重试。')
  }
  if (!isTrustedResult(result)) throw new Error('实例操作返回了无法识别的结果。')
  if (result.ok) return result.value
  throw new Error(result.error.message)
}
