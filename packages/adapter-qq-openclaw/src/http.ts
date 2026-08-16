import { createHash } from 'node:crypto'
import type { QQGatewayAccess } from './gateway.js'
import type { QQOpenClawTransport, QQTarget, QQTransportReceipt } from './index.js'
import { QQTransportError } from './transport-error.js'

export interface QQCredentialResolver {
  resolve(reference: string): Promise<string>
}

export interface QQOpenClawHttpOptions {
  readonly appId: string
  readonly clientSecretCredentialRef: string
  readonly credentials: QQCredentialResolver
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly apiBaseUrl?: string
  readonly tokenBaseUrl?: string
  readonly userAgent?: string
}

type JsonObject = Readonly<Record<string, unknown>>

const object = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}

const string = (...values: readonly unknown[]): string | undefined => {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

const integer = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const retryAfter = (response: Response, now: number): number | undefined => {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined
}

const targetPath = (target: QQTarget, suffix: string): string =>
  target.kind === 'c2c'
    ? `/v2/users/${encodeURIComponent(target.openId)}/${suffix}`
    : `/v2/groups/${encodeURIComponent(target.openId)}/${suffix}`

const mediaFileType = (mediaType: string): number => {
  if (mediaType.startsWith('image/')) return 1
  if (mediaType.startsWith('video/')) return 2
  if (mediaType.startsWith('audio/')) return 3
  return 4
}

const digest = (algorithm: 'md5' | 'sha1', bytes: Uint8Array): string =>
  createHash(algorithm).update(bytes).digest('hex')

const MD5_10M_WINDOW = 10_002_432

/** Fetch-based QQ OpenClaw REST transport with token caching, one 401 refresh and typed/redacted failures. */
export class QQOpenClawHttpTransport implements QQOpenClawTransport, QQGatewayAccess {
  readonly #options: Required<Pick<QQOpenClawHttpOptions, 'appId' | 'clientSecretCredentialRef' | 'credentials'>> &
    Pick<QQOpenClawHttpOptions, 'userAgent'>
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #apiBaseUrl: string
  readonly #tokenBaseUrl: string
  #token: { readonly value: string; readonly expiresAt: number } | undefined
  #tokenRequest: Promise<string> | undefined

  constructor(options: QQOpenClawHttpOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://api.sgroup.qq.com').replace(/\/$/u, '')
    this.#tokenBaseUrl = (options.tokenBaseUrl ?? 'https://bots.qq.com').replace(/\/$/u, '')
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.#token = undefined
    return Promise.resolve()
  }

  accessToken(signal: AbortSignal): Promise<string> {
    return this.#accessToken(signal, false)
  }

  async gatewayUrl(signal: AbortSignal): Promise<string> {
    const response = await this.#requestJson('GET', '/gateway', undefined, signal, false)
    const url = string(response.url)
    if (!url) throw new QQTransportError('transient', 'QQ gateway response omitted its URL.')
    return url
  }

  async sendText(input: {
    readonly target: QQTarget
    readonly markdown: boolean
    readonly content: string
    readonly replyMessageId?: string
    readonly messageSequence?: number
    readonly signal: AbortSignal
  }): Promise<QQTransportReceipt> {
    const body: Record<string, unknown> = input.markdown
      ? { msg_type: 2, markdown: { content: input.content } }
      : { msg_type: 0, content: input.content }
    if (input.replyMessageId) body.msg_id = input.replyMessageId
    if (input.messageSequence !== undefined) body.msg_seq = input.messageSequence
    return this.#messageReceipt(
      await this.#requestJson('POST', targetPath(input.target, 'messages'), body, input.signal, true),
    )
  }

  async upload(input: {
    readonly target: QQTarget
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly fileName?: string
    readonly signal: AbortSignal
  }): Promise<{ readonly fileInfo: string }> {
    const bytes = input.bytes
    const prepared = await this.#requestJson(
      'POST',
      targetPath(input.target, 'upload_prepare'),
      {
        file_type: mediaFileType(input.mediaType),
        file_name: input.fileName ?? 'nekro-nxt-upload',
        file_size: bytes.byteLength,
        md5: digest('md5', bytes),
        sha1: digest('sha1', bytes),
        md5_10m: digest('md5', bytes.subarray(0, MD5_10M_WINDOW)),
      },
      input.signal,
      false,
    )
    const uploadId = string(prepared.upload_id)
    if (!uploadId) throw new QQTransportError('transient', 'QQ upload preparation omitted upload_id.')
    const blockSize = integer(prepared.block_size) ?? bytes.byteLength
    const parts = Array.isArray(prepared.parts) ? prepared.parts.map(object) : []
    for (const [position, rawPart] of parts.entries()) {
      const partIndex = integer(rawPart.index) ?? integer(rawPart.part_number) ?? position + 1
      const offset = integer(rawPart.offset) ?? (partIndex - 1) * blockSize
      const size = integer(rawPart.size) ?? Math.min(blockSize, bytes.byteLength - offset)
      const uploadUrl = string(rawPart.presigned_url, rawPart.upload_url, rawPart.url)
      if (!uploadUrl || size <= 0 || offset < 0 || offset + size > bytes.byteLength) {
        throw new QQTransportError('permanent', 'QQ upload preparation contained an invalid part.')
      }
      const chunk = bytes.subarray(offset, offset + size)
      await this.#putPart(uploadUrl, chunk, input.signal)
      await this.#requestJson(
        'POST',
        targetPath(input.target, 'upload_part_finish'),
        { upload_id: uploadId, part_index: partIndex, block_size: size, md5: digest('md5', chunk) },
        input.signal,
        false,
      )
    }
    const completed = await this.#requestJson(
      'POST',
      targetPath(input.target, 'files'),
      { upload_id: uploadId },
      input.signal,
      false,
    )
    const rawFileInfo = completed.file_info
    const fileInfo = typeof rawFileInfo === 'string' ? rawFileInfo : JSON.stringify(rawFileInfo ?? '')
    if (!fileInfo || fileInfo === '""') {
      throw new QQTransportError('transient', 'QQ upload completion omitted file_info.')
    }
    return { fileInfo }
  }

  async sendMedia(input: {
    readonly target: QQTarget
    readonly fileInfo: string
    readonly replyMessageId?: string
    readonly messageSequence?: number
    readonly signal: AbortSignal
  }): Promise<QQTransportReceipt> {
    const body: Record<string, unknown> = { msg_type: 7, media: { file_info: input.fileInfo } }
    if (input.replyMessageId) body.msg_id = input.replyMessageId
    if (input.messageSequence !== undefined) body.msg_seq = input.messageSequence
    return this.#messageReceipt(
      await this.#requestJson('POST', targetPath(input.target, 'messages'), body, input.signal, true),
    )
  }

  async #accessToken(signal: AbortSignal, forceRefresh: boolean): Promise<string> {
    const now = this.#now()
    if (!forceRefresh && this.#token && this.#token.expiresAt - 60_000 > now) return this.#token.value
    if (!forceRefresh && this.#tokenRequest) return this.#tokenRequest
    const request = this.#requestToken(signal).finally(() => {
      if (this.#tokenRequest === request) this.#tokenRequest = undefined
    })
    this.#tokenRequest = request
    return request
  }

  async #requestToken(signal: AbortSignal): Promise<string> {
    const secret = await this.#options.credentials.resolve(this.#options.clientSecretCredentialRef)
    if (!secret) throw new QQTransportError('authentication', 'QQ credential reference resolved to an empty secret.')
    let response: Response
    try {
      response = await this.#fetch(`${this.#tokenBaseUrl}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': this.#options.userAgent ?? 'NekroNxt/1' },
        body: JSON.stringify({ appId: this.#options.appId, clientSecret: secret }),
        signal,
      })
    } catch (error) {
      throw new QQTransportError('transient', 'QQ token request failed before authentication completed.', {
        cause: error,
      })
    }
    if (!response.ok) throw this.#httpError(response, false)
    const data = await this.#json(response)
    const token = string(data.access_token, data.accessToken)
    if (!token) throw new QQTransportError('authentication', 'QQ token response omitted access_token.')
    const expiresIn = integer(data.expires_in) ?? integer(data.expiresIn) ?? 7_200
    this.#token = { value: token, expiresAt: this.#now() + Math.max(60, expiresIn) * 1_000 }
    return token
  }

  async #requestJson(
    method: 'GET' | 'POST',
    path: string,
    body: Readonly<Record<string, unknown>> | undefined,
    signal: AbortSignal,
    submissionRisk: boolean,
    retryAuthentication = true,
  ): Promise<JsonObject> {
    const token = await this.#accessToken(signal, false)
    let response: Response
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
          'user-agent': this.#options.userAgent ?? 'NekroNxt/1',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
    } catch (error) {
      throw new QQTransportError(submissionRisk ? 'unknown' : 'transient', `QQ ${method} ${path} failed.`, {
        cause: error,
      })
    }
    if (response.status === 401 && retryAuthentication) {
      this.#token = undefined
      await this.#accessToken(signal, true)
      return this.#requestJson(method, path, body, signal, submissionRisk, false)
    }
    if (!response.ok) throw this.#httpError(response, submissionRisk)
    return this.#json(response)
  }

  async #putPart(url: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    let response: Response
    try {
      response = await this.#fetch(url, { method: 'PUT', body: Buffer.from(bytes), signal })
    } catch (error) {
      throw new QQTransportError('transient', 'QQ upload part request failed.', { cause: error })
    }
    if (!response.ok) throw this.#httpError(response, false)
  }

  #httpError(response: Response, submissionRisk: boolean): QQTransportError {
    const message = `QQ HTTP request failed with status ${response.status}.`
    if (response.status === 401 || response.status === 403) return new QQTransportError('authentication', message)
    if (response.status === 429) {
      const delay = retryAfter(response, this.#now())
      return new QQTransportError('rate-limited', message, delay === undefined ? {} : { retryAfterMs: delay })
    }
    if (response.status >= 400 && response.status < 500) return new QQTransportError('permanent', message)
    return new QQTransportError(submissionRisk ? 'unknown' : 'transient', message)
  }

  async #json(response: Response): Promise<JsonObject> {
    if (response.status === 204) return {}
    try {
      return object(await response.json())
    } catch (error) {
      throw new QQTransportError('transient', 'QQ response was not valid JSON.', { cause: error })
    }
  }

  #messageReceipt(response: JsonObject): QQTransportReceipt {
    const platformMessageId = string(response.id, response.msg_id)
    if (!platformMessageId) throw new QQTransportError('unknown', 'QQ message response omitted its message ID.')
    const refIndex = string(object(response.ext_info).ref_idx)
    return { platformMessageId, ...(refIndex === undefined ? {} : { refIndex }) }
  }
}
