import type { DeviceCredential } from './credential-vault.js'
import { InstanceOperationError } from './instance-operation-error.js'
import { remoteTransportForOrigin, type InstanceProfile } from './instance-profiles.js'
import { fetchSameOriginRemote, type RemoteFetch } from './remote-navigation.js'
import { observeRemoteSpki, parseRemoteDescriptor } from './remote-pairing.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_PROBE_TIMEOUT_MS = 4_000
const DEFAULT_REVOKE_TIMEOUT_MS = 8_000

const boundedSignal = (parent: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

export interface EstablishRemoteSessionInput {
  readonly profile: InstanceProfile
  readonly fetcher: RemoteFetch
  readonly credential?: DeviceCredential
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
  readonly observeSpki?: (origin: string, signal: AbortSignal) => Promise<string>
}

/** Verifies identity, descriptor and management session under one abortable request budget. */
export const establishRemoteSession = async (input: EstablishRemoteSessionInput): Promise<void> => {
  const { profile } = input
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const requestSignal = (): AbortSignal => boundedSignal(input.signal, requestTimeoutMs)
  const secure = new URL(profile.origin).protocol === 'https:'
  if (secure) {
    const observedSpki = await (input.observeSpki ?? observeRemoteSpki)(profile.origin, requestSignal())
    if (observedSpki !== profile.pinnedSpkiSha256) {
      throw new InstanceOperationError('tls-identity-changed', '服务器 TLS 身份已经变化，请重新认证。')
    }
  }
  const descriptorResponse = await fetchSameOriginRemote(input.fetcher, profile.origin, '/.well-known/nekro-nxt', {
    signal: requestSignal(),
  })
  if (!descriptorResponse.ok) {
    throw new InstanceOperationError('operation-failed', `实例描述请求失败（HTTP ${descriptorResponse.status}）。`)
  }
  const descriptor = parseRemoteDescriptor(
    await descriptorResponse.json(),
    profile.transport ?? remoteTransportForOrigin(profile.origin),
  )
  if (descriptor.instanceId !== profile.observedInstanceId) {
    throw new InstanceOperationError('instance-identity-changed', '实例描述中的 instanceId 与保存的身份不一致。')
  }
  if (profile.transport === 'loopback-http') return
  const currentSession = await fetchSameOriginRemote(input.fetcher, profile.origin, '/api/management/session', {
    credentials: 'include',
    signal: requestSignal(),
  })
  if (currentSession.ok) return
  if (input.credential === undefined) {
    throw new InstanceOperationError('authentication-required', '本地设备凭据不可用。')
  }
  const response = await fetchSameOriginRemote(input.fetcher, profile.origin, '/api/management/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.credential),
    signal: requestSignal(),
  })
  if (!response.ok) {
    throw new InstanceOperationError('authentication-required', `设备会话请求失败（HTTP ${response.status}）。`)
  }
}

export interface ProbeRemoteProfileInput extends Omit<EstablishRemoteSessionInput, 'signal'> {
  readonly signal: AbortSignal
  readonly probeTimeoutMs?: number
}

/** Covers health, descriptor, TLS identity and management session with one total probe cancellation signal. */
export const probeRemoteProfile = async (input: ProbeRemoteProfileInput): Promise<'ready'> => {
  const probeSignal = boundedSignal(input.signal, input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  const response = await fetchSameOriginRemote(input.fetcher, input.profile.origin, '/health/ready', {
    signal: probeSignal,
  })
  if (!response.ok) {
    throw new InstanceOperationError('unreachable', `实例就绪请求失败（HTTP ${response.status}）。`)
  }
  await establishRemoteSession({
    ...input,
    signal: probeSignal,
  })
  return 'ready'
}

export interface TryRevokeRemoteDeviceInput {
  readonly profile: InstanceProfile
  readonly fetcher: RemoteFetch
  readonly credential: DeviceCredential
  readonly totalTimeoutMs?: number
}

/** Best-effort remote revoke bounded by one signal; every failure still returns control to local removal. */
export const tryRevokeRemoteDevice = async (input: TryRevokeRemoteDeviceInput): Promise<void> => {
  const totalTimeoutMs = input.totalTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS
  const signal = AbortSignal.timeout(totalTimeoutMs)
  try {
    await establishRemoteSession({
      profile: input.profile,
      fetcher: input.fetcher,
      credential: input.credential,
      signal,
      requestTimeoutMs: totalTimeoutMs,
    })
    const sessionResponse = await fetchSameOriginRemote(
      input.fetcher,
      input.profile.origin,
      '/api/management/session',
      { credentials: 'include', signal },
    )
    if (!sessionResponse.ok) return
    const state: unknown = await sessionResponse.json()
    if (typeof state !== 'object' || state === null || !('csrfToken' in state) || typeof state.csrfToken !== 'string') {
      return
    }
    await fetchSameOriginRemote(
      input.fetcher,
      input.profile.origin,
      `/api/management/devices/${encodeURIComponent(input.credential.deviceId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'x-nxt-csrf': state.csrfToken, origin: input.profile.origin },
        signal,
      },
    )
  } catch {
    // Remote revoke must never prevent local credential, partition and Profile cleanup.
  }
}
