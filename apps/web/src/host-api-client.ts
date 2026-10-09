import { hostReleaseGuard, type HostReleaseGuard } from './host-release-guard.js'
import { managementCsrfToken, redirectToSignIn } from './management-access.js'
import {
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  type HostApiContract,
  type HostApiContractParams,
  type HostApiContractRequest,
  type HostApiRequest,
} from '@nekro-nxt/contracts'

export interface HostRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly releaseGuard?: HostReleaseGuard
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
    readonly kind: 'network' | 'http' | 'invalid-response' | 'timeout' | 'aborted' | 'release-mismatch',
    message: string,
    readonly status?: number,
    readonly commitState: 'not-applicable' | 'rejected' | 'unknown' = 'not-applicable',
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

/**
 * Server messages written for users are Chinese; anything else is an internal check meant for developers, shown as
 * a plain failure that still carries the original text for bug reports.
 */
const readableFailure = (message: string): string =>
  /\p{Script=Han}/u.test(message) ? message : `操作失败（${message}）`

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
  const releaseGuard = options.releaseGuard ?? hostReleaseGuard
  if (mutation) {
    try {
      await releaseGuard.beforeMutation()
    } catch (cause) {
      throw new HostRequestError(
        releaseGuard.getSnapshot().mismatch ? 'release-mismatch' : 'network',
        cause instanceof Error ? cause.message : '还没连上服务，这次操作没有发出。',
        undefined,
        'rejected',
      )
    }
    if (options.signal?.aborted) throw new HostRequestError('aborted', '服务请求已取消。', undefined, 'rejected')
  }
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
          ...(releaseGuard.getSnapshot().expected
            ? { 'x-nekro-client-release': releaseGuard.getSnapshot().expected! }
            : {}),
          // Desktop adds this itself; a plain browser behind the management edge sends the cookie's token.
          ...(mutation && managementCsrfToken() !== undefined ? { 'x-nxt-csrf': managementCsrfToken()! } : {}),
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
            : '无法连接服务。'
      throw new HostRequestError(
        kind,
        mutation ? `${message} 操作结果未知，请先刷新确认。` : message,
        undefined,
        mutation ? 'unknown' : 'not-applicable',
      )
    }
    if (!response.ok) {
      const error = HostApiErrorSchema.safeParse(json)
      if (response.status === 401 && error.success && error.data.error.code === 'authentication_required') {
        redirectToSignIn()
      }
      // Host can reject a release that changed after our preflight probe.
      if (error.success && error.data.error.code === 'release-mismatch') {
        releaseGuard.rejectCurrentRelease()
        throw new HostRequestError(
          'release-mismatch',
          error.data.error.message,
          response.status,
          mutation ? 'rejected' : 'not-applicable',
        )
      }
      throw new HostRequestError(
        'http',
        error.success ? readableFailure(error.data.error.message) : `操作失败（服务返回 ${response.status}）。`,
        response.status,
        mutation ? (response.status >= 500 ? 'unknown' : 'rejected') : 'not-applicable',
      )
    }
    if (path === '/api/snapshot' && typeof json === 'object' && json !== null && 'productMetadata' in json) {
      const metadata = json.productMetadata
      if (typeof metadata === 'object' && metadata !== null && 'releaseId' in metadata) {
        releaseGuard.observe(metadata.releaseId)
        try {
          releaseGuard.assertCompatible()
        } catch (cause) {
          throw new HostRequestError('release-mismatch', cause instanceof Error ? cause.message : '页面需要刷新。')
        }
      }
    }
    try {
      const decode: (input: unknown) => Output = contract.parseResponse
      return decode(json)
    } catch (cause) {
      throw new HostRequestError(
        'invalid-response',
        `服务返回的数据无法识别：${cause instanceof Error ? cause.message : String(cause)}`,
        response.status,
        mutation ? 'unknown' : 'not-applicable',
      )
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/**
 * Workspace read models and runtime controls (Decision 2026-10-04 §7). Thin typed calls over the shared
 * transport; mutations keep its unknown-commit semantics and are never retried automatically.
 */
export const workspaceApi = {
  markChannelRead: (
    channelId: string,
    upTo?: { readonly occurredAt: number; readonly sourceId: string },
    options?: HostRequestOptions,
  ) =>
    callHostApi(
      HostApiContracts.markChannelRead,
      { channelId },
      upTo === undefined ? {} : { upTo: { occurredAt: upTo.occurredAt, sourceId: upTo.sourceId } },
      options,
    ),
  listAttention: (options?: HostRequestOptions) => callHostApi(HostApiContracts.listAttention, {}, undefined, options),
  dismissAttention: (attentionId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.dismissAttention, { attentionId }, undefined, options),
  getChannelPending: (channelId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.getChannelPending, { channelId }, undefined, options),
  stopChannelTask: (channelId: string, expectedEpisodeId?: string, options?: HostRequestOptions) =>
    callHostApi(
      HostApiContracts.stopChannelTask,
      { channelId },
      expectedEpisodeId === undefined ? {} : { expectedEpisodeId },
      options,
    ),
  resolveOutbound: (outboundId: string, action: 'retry' | 'confirm-delivered', options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.resolveOutbound, { outboundId }, { action }, options),
  getChannelToolCall: (channelId: string, callId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.getChannelToolCall, { channelId, callId }, undefined, options),
  getChannelPrompt: (channelId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.getChannelPrompt, { channelId }, undefined, options),
  updateChannelPrompt: (
    channelId: string,
    request: HostApiRequest<'updateChannelPrompt'>,
    options?: HostRequestOptions,
  ) => callHostApi(HostApiContracts.updateChannelPrompt, { channelId }, request, options),
  getChannelRuntimeInput: (channelId: string, messageId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.getChannelRuntimeInput, { channelId, messageId }, undefined, options),
  getChannelRuntimeContext: (channelId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.getChannelRuntimeContext, { channelId }, undefined, options),
  getChannelActivity: (
    query: { readonly window?: string; readonly bucket?: string } = {},
    options?: HostRequestOptions,
  ) =>
    callHostApi(
      HostApiContracts.getChannelActivity,
      {
        ...(query.window === undefined ? {} : { window: query.window }),
        ...(query.bucket === undefined ? {} : { bucket: query.bucket }),
      },
      undefined,
      options,
    ),
  listAgentRevisions: (agentId: string, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.listAgentRevisions, { agentId }, undefined, options),
  restoreAgentRevision: (
    agentId: string,
    revisionId: string,
    expectedCurrentRevisionId: string,
    options?: HostRequestOptions,
  ) =>
    callHostApi(HostApiContracts.restoreAgentRevision, { agentId, revisionId }, { expectedCurrentRevisionId }, options),
  updateAgentAppearance: (
    agentId: string,
    patch: { readonly hue?: number | null; readonly avatarAssetId?: null },
    options?: HostRequestOptions,
  ) =>
    callHostApi(
      HostApiContracts.updateAgentAppearance,
      { agentId },
      {
        ...(patch.hue === undefined ? {} : { hue: patch.hue }),
        ...(patch.avatarAssetId === undefined ? {} : { avatarAssetId: patch.avatarAssetId }),
      },
      options,
    ),
  uploadAgentAvatar: (agentId: string, bytes: Uint8Array<ArrayBuffer>, options?: HostRequestOptions) =>
    callHostApi(HostApiContracts.uploadAgentAvatar, { agentId }, { bytes }, options),
  /** Same-origin URL of the agent's avatar image; it 404s when no avatar is set. */
  agentAvatarUrl: (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/avatar`,
}
