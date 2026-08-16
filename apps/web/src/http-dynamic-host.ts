import type { DynamicClientHostPort } from './dsh-dynamic-client.js'

// Derive the exact Host-seam types from the interface so we never import a DSH
// package that is not a direct dependency of this app.
type Host = DynamicClientHostPort
type HostHalfResult = Awaited<ReturnType<Host['runHostHalf']>>
type ClientSource = Awaited<ReturnType<Host['getClientCode']>>
type ResolveAck = Awaited<ReturnType<Host['resolveRequestRun']>>
type RunResolution = Parameters<Host['settleUserRun']>[2]
type RunResponse = Awaited<ReturnType<Host['settleUserRun']>>

/**
 * Real `DynamicClientHostPort` that drives the browser dynamic Client circuit
 * against the NekroNxt Server domain API (design docs/08). The agentId scopes
 * every operation to the intelligent-agent whose live DSH Session owns the
 * dynamic Package.
 */
export class HttpDynamicClientHost implements DynamicClientHostPort {
  readonly #agentId: string

  constructor(agentId: string) {
    this.#agentId = agentId
  }

  runHostHalf(
    agentId: string,
    pluginId: string,
    packageId: string,
    mode: 'run' | 'update',
    requestId: string | null,
    approveFutureVersions: boolean,
  ): Promise<HostHalfResult> {
    void agentId
    return this.#post('run-host-half', {
      pluginId,
      packageId,
      mode,
      requestId,
      approveFutureVersions,
    }) as Promise<HostHalfResult>
  }

  getClientCode(_agentId: string, pluginId: string, pluginRunId: string): Promise<ClientSource> {
    void _agentId
    return this.#post('get-client-code', { pluginId, pluginRunId }) as Promise<ClientSource>
  }

  resolveRequestRun(requestId: string, resolution: unknown): Promise<ResolveAck> {
    const pluginRunId =
      typeof resolution === 'object' && resolution !== null && 'pluginRunId' in resolution
        ? extractPluginRunId(resolution.pluginRunId)
        : ''
    return this.#post(resolutionAccepted(resolution) ? 'approve' : 'decline', {
      requestId,
      ...(pluginRunId.trim() ? { pluginRunId } : {}),
    }) as Promise<ResolveAck>
  }

  settleUserRun(agentId: string, pluginId: string, resolution: RunResolution): Promise<RunResponse> {
    void agentId
    return this.#post('settle-user-run', { pluginId, resolution }) as Promise<RunResponse>
  }

  invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown> {
    return this.#post('invoke', { pluginId, pluginRunId, method, args })
  }

  reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    void agentId
    return this.#post('report-render-failure', { pluginId, pluginRunId, failure }) as Promise<void>
  }

  reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    void agentId
    void pluginId
    void pluginRunId
    void failure
    return Promise.resolve()
  }

  async #post(action: string, body: unknown): Promise<unknown> {
    const response = await fetch(`/api/dynamic/${encodeURIComponent(this.#agentId)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`Dynamic Host 请求失败：${response.status}`)
    return json
  }
}

const resolutionAccepted = (resolution: unknown): boolean =>
  typeof resolution === 'object' && resolution !== null && (resolution as { ok?: unknown }).ok === true

const extractPluginRunId = (value: unknown): string => (typeof value === 'string' ? value : '')
