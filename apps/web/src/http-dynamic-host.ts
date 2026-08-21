import {
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  parseJsonValue,
  type HostApiContract,
  type HostApiContractParams,
  type HostApiContractRequest,
} from '@nekro-nxt/contracts'
import type { DynamicClientHostPort, DynamicInventoryRow } from './dsh-dynamic-client.js'
import { requireDynamicPackageId, requireDynamicPluginId, requireDynamicPluginRunId } from './dsh-interop/unsafe.js'

// Derive the exact Host-seam types from the interface so we never import a DSH
// package that is not a direct dependency of this app.
type Host = DynamicClientHostPort
type HostHalfResult = Awaited<ReturnType<Host['runHostHalf']>>
type ClientSource = Awaited<ReturnType<Host['getClientCode']>>
type ResolveAck = Awaited<ReturnType<Host['resolveRequestRun']>>
type RunResolution = Parameters<Host['settleUserRun']>[2]
type RunResponse = Awaited<ReturnType<Host['settleUserRun']>>
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/**
 * Real `DynamicClientHostPort` that drives the browser dynamic Client circuit
 * against the NekroNxt Server domain API (design docs/08). The agentId scopes
 * every operation to the intelligent-agent whose live DSH Session owns the
 * dynamic Package.
 */
export class HttpDynamicClientHost implements DynamicClientHostPort {
  readonly #agentId: string
  readonly #episodeId: string

  constructor(agentId: string, episodeId: string) {
    this.#agentId = agentId
    this.#episodeId = episodeId
  }

  async inventory(): Promise<readonly DynamicInventoryRow[]> {
    const result = await this.#post(
      HostApiContracts.dynamicInventory,
      { agentId: this.#agentId },
      { episodeId: this.#episodeId },
    )
    return result.rows.map((row) => ({
      pluginId: row.pluginId,
      agentId: row.agentId,
      packages: row.packages.map((pkg) => ({ ...pkg })),
      ...(row.activeRun === undefined ? {} : { activeRun: { ...row.activeRun } }),
      ...(row.latestRun === undefined
        ? {}
        : {
            latestRun: {
              pluginRunId: row.latestRun.pluginRunId,
              packageId: row.latestRun.packageId,
              mode: row.latestRun.mode,
              status: row.latestRun.status,
              ...(row.latestRun.approvalRequestId === undefined
                ? {}
                : { approvalRequestId: row.latestRun.approvalRequestId }),
              ...(row.latestRun.requiresApproval === undefined
                ? {}
                : { requiresApproval: row.latestRun.requiresApproval }),
            },
          }),
    }))
  }

  async runHostHalf(
    agentId: string,
    pluginId: string,
    packageId: string,
    mode: 'run' | 'update',
    requestId: string | null,
    approveFutureVersions: boolean,
  ): Promise<HostHalfResult> {
    void agentId
    const result = await this.#post(
      HostApiContracts.dynamicRunHostHalf,
      { agentId: this.#agentId },
      { episodeId: this.#episodeId, pluginId, packageId, mode, requestId, approveFutureVersions },
    )
    return result.ok
      ? {
          ...result,
          pluginId: requireDynamicPluginId(result.pluginId),
          packageId: requireDynamicPackageId(result.packageId),
          pluginRunId: requireDynamicPluginRunId(result.pluginRunId),
        }
      : { ok: false, message: result.message, ...(result.stack === undefined ? {} : { stack: result.stack }) }
  }

  async getClientCode(_agentId: string, pluginId: string, pluginRunId: string): Promise<ClientSource> {
    void _agentId
    const source = await this.#post(
      HostApiContracts.dynamicGetClientCode,
      { agentId: this.#agentId },
      { episodeId: this.#episodeId, pluginId, pluginRunId },
    )
    return {
      ...source,
      pluginId: requireDynamicPluginId(source.pluginId),
      packageId: requireDynamicPackageId(source.packageId),
      pluginRunId: requireDynamicPluginRunId(source.pluginRunId),
    }
  }

  resolveRequestRun(requestId: string, resolution: unknown): Promise<ResolveAck> {
    const pluginRunId =
      typeof resolution === 'object' && resolution !== null && 'pluginRunId' in resolution
        ? extractPluginRunId(resolution.pluginRunId)
        : ''
    const body = { episodeId: this.#episodeId, requestId, ...(pluginRunId.trim() ? { pluginRunId } : {}) }
    return resolutionAccepted(resolution)
      ? this.#post(HostApiContracts.dynamicApprove, { agentId: this.#agentId }, body)
      : this.#post(HostApiContracts.dynamicDecline, { agentId: this.#agentId }, body)
  }

  async settleUserRun(agentId: string, pluginId: string, resolution: RunResolution): Promise<RunResponse> {
    void agentId
    const normalizedResolution = resolution.ok
      ? {
          ok: true as const,
          pluginRunId: resolution.pluginRunId,
          ...(resolution.waitingFor === undefined ? {} : { waitingFor: [...resolution.waitingFor] }),
        }
      : {
          ok: false as const,
          reason: resolution.reason,
          ...(resolution.pluginRunId === undefined ? {} : { pluginRunId: resolution.pluginRunId }),
          ...(resolution.startedHere === undefined ? {} : { startedHere: resolution.startedHere }),
          ...(resolution.message === undefined ? {} : { message: resolution.message }),
          ...(resolution.stack === undefined ? {} : { stack: resolution.stack }),
        }
    const result = await this.#post(
      HostApiContracts.dynamicSettleUserRun,
      { agentId: this.#agentId },
      { episodeId: this.#episodeId, pluginId, resolution: normalizedResolution },
    )
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.message,
        ...(result.stack === undefined ? {} : { stack: result.stack }),
      }
    }
    return {
      ok: true,
      status: result.status,
      pluginId: requireDynamicPluginId(result.pluginId),
      packageId: requireDynamicPackageId(result.packageId),
      pluginRunId: requireDynamicPluginRunId(result.pluginRunId),
      waitingFor: result.waitingFor,
      ...(result.clientWaitingFor === undefined ? {} : { clientWaitingFor: result.clientWaitingFor }),
      ...(result.currentPackageId === undefined
        ? {}
        : { currentPackageId: requireDynamicPackageId(result.currentPackageId) }),
      ...(result.nextPackageId === undefined ? {} : { nextPackageId: requireDynamicPackageId(result.nextPackageId) }),
      mode: result.mode,
    }
  }

  async invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown> {
    const result = await this.#post(
      HostApiContracts.dynamicInvoke,
      { agentId: this.#agentId },
      {
        episodeId: this.#episodeId,
        pluginId,
        pluginRunId,
        method,
        ...(args === undefined ? {} : { args: parseJsonValue(args) }),
      },
    )
    if (!result.ok) throw new Error(result.message)
    return result.value
  }

  async reportRenderFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    void agentId
    const body = HostApiContracts.dynamicReportRenderFailure.parseRequest({
      episodeId: this.#episodeId,
      pluginId,
      pluginRunId,
      failure,
    })
    await this.#post(HostApiContracts.dynamicReportRenderFailure, { agentId: this.#agentId }, body)
  }

  async reportGuardFailure(agentId: string, pluginId: string, pluginRunId: string, failure: unknown): Promise<void> {
    void agentId
    const record = isRecord(failure) ? failure : {}
    const message = typeof record['message'] === 'string' ? record['message'] : String(failure)
    const stack = typeof record['stack'] === 'string' ? record['stack'] : undefined
    await this.#post(
      HostApiContracts.dynamicReportGuardFailure,
      { agentId: this.#agentId },
      {
        episodeId: this.#episodeId,
        pluginId,
        pluginRunId,
        message,
        ...(stack === undefined ? {} : { stack }),
      },
    )
  }

  async reportClientVerification(
    agentId: string,
    pluginId: string,
    packageId: string,
    pluginRunId: string,
    renderedSlots: readonly ('agent.workbench.sections' | 'extension.details.panels')[],
  ): Promise<void> {
    void agentId
    await this.#post(
      HostApiContracts.dynamicReportClientVerification,
      { agentId: this.#agentId },
      {
        episodeId: this.#episodeId,
        pluginId,
        packageId,
        pluginRunId,
        renderedSlots: [...renderedSlots],
      },
    )
  }

  async #post<Contract extends HostApiContract, Output>(
    contract: Contract & { readonly parseResponse: (input: unknown) => Output },
    params: HostApiContractParams<Contract>,
    body: HostApiContractRequest<Contract>,
  ): Promise<Output> {
    const requestBody = contract.parseRequest(body)
    const response = await fetch(buildHostApiContractPath(contract, params), {
      method: contract.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsedError = HostApiErrorSchema.safeParse(json)
      throw new Error(
        parsedError.success ? parsedError.data.error.message : `Dynamic Host 请求失败：${response.status}`,
      )
    }
    try {
      const parseResponse: (input: unknown) => Output = contract.parseResponse
      return parseResponse(json)
    } catch (cause) {
      throw new Error(`Dynamic Host 返回的数据格式无效：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

const resolutionAccepted = (resolution: unknown): boolean =>
  typeof resolution === 'object' && resolution !== null && 'ok' in resolution && resolution.ok === true

const extractPluginRunId = (value: unknown): string => (typeof value === 'string' ? value : '')
