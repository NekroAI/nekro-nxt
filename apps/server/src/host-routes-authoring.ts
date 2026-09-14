import {
  AgentIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  EpisodeIdSchema,
  HostApiContracts,
  type AgentId,
} from '@nekro-nxt/contracts'
import { projectAuthoringAttempt, projectAuthoringTask } from './host-queries.js'
import {
  normalizeDynamicResolution,
  readJsonBody,
  resolveEpisodeSession,
  writeContractJson,
  writeError,
  writeJson,
  type DynamicRunResolution,
  type HostRouteContext,
} from './host-route-support.js'
export function registerAuthoringRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  registerRoute({
    kind: 'prefix',
    path: '/api/authoring/tasks',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const decisionMatch = /^\/api\/authoring\/tasks\/([^/]+)\/attempts\/([^/]+)\/decision$/.exec(url.pathname)
      const stopMatch = /^\/api\/authoring\/tasks\/([^/]+)\/stop$/.exec(url.pathname)
      const taskMatch = /^\/api\/authoring\/tasks\/([^/]+)$/.exec(url.pathname)
      try {
        if (decisionMatch) {
          if (req.method !== 'POST') throw new Error('创造任务审批只支持 POST。')
          const taskId = AuthoringTaskIdSchema.parse(decodeURIComponent(decisionMatch[1] ?? ''))
          const attemptId = AuthoringAttemptIdSchema.parse(decodeURIComponent(decisionMatch[2] ?? ''))
          const params = HostApiContracts.decideAuthoringAttempt.parseParams({ taskId, attemptId })
          const body = HostApiContracts.decideAuthoringAttempt.parseRequest(await readJsonBody(req))
          const result = runtime.authoring.decide({ ...params, ...body })
          writeContractJson(res, 200, HostApiContracts.decideAuthoringAttempt, result)
          return
        }
        if (stopMatch) {
          if (req.method !== 'POST') throw new Error('停止创造任务只支持 POST。')
          const taskId = AuthoringTaskIdSchema.parse(decodeURIComponent(stopMatch[1] ?? ''))
          const params = HostApiContracts.stopAuthoringTask.parseParams({ taskId })
          const body = HostApiContracts.stopAuthoringTask.parseRequest(await readJsonBody(req))
          const task = await runtime.authoring.stop({ ...params, ...body })
          writeContractJson(res, 200, HostApiContracts.stopAuthoringTask, projectAuthoringTask(runtime, task))
          return
        }
        if (!taskMatch) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const taskId = AuthoringTaskIdSchema.parse(decodeURIComponent(taskMatch[1] ?? ''))
        if (req.method === 'DELETE') {
          const deleted = await runtime.host.deleteAuthoringTask(taskId)
          writeContractJson(res, 200, HostApiContracts.deleteAuthoringTask, { deleted })
          return
        }
        if (req.method !== 'GET') throw new Error('创造任务详情只支持 GET。')
        const task = runtime.repository.getAuthoringTask(taskId)
        if (!task) throw new Error('创造任务不存在。')
        writeContractJson(res, 200, HostApiContracts.getAuthoringTask, {
          task: projectAuthoringTask(runtime, task),
          attempts: runtime.repository.listAuthoringAttempts(task.id).map(projectAuthoringAttempt),
          events: runtime.repository.listAuthoringEvents(task.id).map((event) => ({
            sequence: event.sequence,
            kind: event.kind,
            ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
            payload: event.payload,
            createdAt: event.createdAt,
          })),
        })
      } catch (error) {
        writeError(res, 400, 'authoring-operation-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dynamic',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match =
        /^\/api\/dynamic\/([^/]+)\/(inventory|approve|decline|invoke|get-client-code|report-render-failure|report-guard-failure|report-client-verification|run-host-half|settle-user-run)$/.exec(
          url.pathname,
        )
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const encodedAgentId = match[1]
      const action = match[2]
      if (encodedAgentId === undefined || action === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let agentId: AgentId
      try {
        agentId = AgentIdSchema.parse(decodeURIComponent(encodedAgentId))
      } catch {
        writeError(res, 400, 'invalid-agent', '无效的智能体 ID。')
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      let dshSessionId: string
      try {
        const episodeId = EpisodeIdSchema.parse(
          typeof body === 'object' && body !== null && !Array.isArray(body)
            ? Reflect.get(body, 'episodeId')
            : undefined,
        )
        dshSessionId = resolveEpisodeSession(runtime, agentId, episodeId)
      } catch (error) {
        writeError(res, 400, 'no-session', error instanceof Error ? error.message : String(error))
        return
      }
      if (action === 'inventory') {
        HostApiContracts.dynamicInventory.parseRequest(body)
        writeJson(
          res,
          200,
          HostApiContracts.dynamicInventory.parseResponse({ rows: runtime.host.dynamicInventory(dshSessionId) }),
        )
        return
      }
      if (action === 'approve' || action === 'decline') {
        const contract = action === 'approve' ? HostApiContracts.dynamicApprove : HostApiContracts.dynamicDecline
        const parsed = contract.parseRequest(body)
        try {
          const pending = runtime.host
            .dynamicInventory(dshSessionId)
            .find((row) => row.latestRun?.approvalRequestId === parsed.requestId)?.latestRun
          if (action === 'approve' && pending === undefined) {
            throw new Error('指定批准请求不属于该智能体的活动会话。')
          }
          if (parsed.pluginRunId !== undefined && pending?.pluginRunId !== parsed.pluginRunId) {
            throw new Error('批准请求与动态运行不匹配。')
          }
          let resolution: DynamicRunResolution
          if (action === 'approve') {
            if (pending === undefined) throw new Error('指定批准请求不属于该智能体的活动会话。')
            resolution = { ok: true, pluginRunId: pending.pluginRunId }
          } else {
            resolution = { ok: false, reason: 'rejected' }
          }
          const ack = await runtime.host.resolveDynamicRunRequest(dshSessionId, parsed.requestId, resolution)
          writeJson(res, 200, contract.parseResponse({ accepted: ack.accepted }))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-operation-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'invoke') {
        const parsed = HostApiContracts.dynamicInvoke.parseRequest(body)
        try {
          const result = await runtime.host.invokeDynamicHost(
            dshSessionId,
            parsed.pluginId,
            parsed.pluginRunId,
            parsed.method,
            parsed.args,
          )
          writeJson(
            res,
            200,
            HostApiContracts.dynamicInvoke.parseResponse({
              ok: result.ok,
              ...(result.ok ? { value: result.value } : { message: result.message }),
            }),
          )
        } catch (error) {
          writeError(res, 400, 'dynamic-invoke-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'run-host-half') {
        const parsed = HostApiContracts.dynamicRunHostHalf.parseRequest(body)
        try {
          const result = await runtime.host.runDynamicHostHalf(
            dshSessionId,
            parsed.pluginId,
            parsed.packageId,
            parsed.mode,
            parsed.requestId ?? null,
            parsed.approveFutureVersions,
          )
          writeJson(res, 200, HostApiContracts.dynamicRunHostHalf.parseResponse(result))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-host-half-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'settle-user-run') {
        const parsed = HostApiContracts.dynamicSettleUserRun.parseRequest(body)
        try {
          const result = await runtime.host.settleDynamicUserRun(
            dshSessionId,
            parsed.pluginId,
            normalizeDynamicResolution(runtime, dshSessionId, parsed.resolution),
          )
          writeJson(res, 200, HostApiContracts.dynamicSettleUserRun.parseResponse(result))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-settle-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'get-client-code') {
        const parsed = HostApiContracts.dynamicGetClientCode.parseRequest(body)
        try {
          const client = runtime.host.getDynamicClientCode(dshSessionId, parsed.pluginId, parsed.pluginRunId)
          writeJson(
            res,
            200,
            HostApiContracts.dynamicGetClientCode.parseResponse({
              pluginId: client.pluginId,
              packageId: client.packageId,
              pluginRunId: client.pluginRunId,
              name: client.name,
              code: client.code,
            }),
          )
        } catch (error) {
          writeError(res, 400, 'dynamic-client-code-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-render-failure') {
        const parsed = HostApiContracts.dynamicReportRenderFailure.parseRequest(body)
        try {
          await runtime.host.reportDynamicRenderFailure(dshSessionId, parsed.pluginId, parsed.pluginRunId, {
            slot: parsed.failure.slot,
            message: parsed.failure.message,
            abdicated: parsed.failure.abdicated,
            ...(parsed.failure.stack === undefined ? {} : { stack: parsed.failure.stack }),
          })
          writeJson(res, 200, HostApiContracts.dynamicReportRenderFailure.parseResponse({ ok: true }))
          broadcast({ event: 'dynamic-changed', data: { agentId } })
        } catch (error) {
          writeError(res, 400, 'dynamic-render-failure', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-client-verification') {
        const parsed = HostApiContracts.dynamicReportClientVerification.parseRequest(body)
        try {
          await runtime.host.recordDynamicClientVerification(
            dshSessionId,
            parsed.pluginId,
            parsed.packageId,
            parsed.pluginRunId,
            parsed.renderedSlots,
            parsed.renderedHostSlots,
            parsed.renderedPages,
            parsed.usedUiComponents,
            parsed.pageGeometry,
            parsed.permissions,
            parsed.navigationEntries,
          )
          writeJson(res, 200, HostApiContracts.dynamicReportClientVerification.parseResponse({ ok: true }))
        } catch (error) {
          writeError(res, 400, 'dynamic-client-verification', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'report-guard-failure') {
        const parsed = HostApiContracts.dynamicReportGuardFailure.parseRequest(body)
        try {
          await runtime.host.reportDynamicGuardFailure(dshSessionId, parsed.pluginId, parsed.pluginRunId, {
            message: parsed.message,
            ...(parsed.stack === undefined ? {} : { stack: parsed.stack }),
          })
          writeJson(res, 200, HostApiContracts.dynamicReportGuardFailure.parseResponse({ ok: true }))
        } catch (error) {
          writeError(res, 400, 'dynamic-guard-failure', error instanceof Error ? error.message : String(error))
        }
        return
      }
      writeError(res, 501, 'not-implemented', '该动态操作尚未开放。')
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/extensions/save-from-dynamic',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.saveExtensionFromDynamic.parseRequest>
      try {
        parsed = HostApiContracts.saveExtensionFromDynamic.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        const saved = await runtime.authoring.save(parsed)
        writeJson(
          res,
          200,
          HostApiContracts.saveExtensionFromDynamic.parseResponse({
            extensionId: saved.extension.id,
            revisionId: saved.revision.id,
            activation: 'inactive',
            ...(runtime.repository.getExtensionRevisionVerification(saved.revision.id)?.scope === 'host-adapter'
              ? { installation: 'uninstalled' as const }
              : {}),
          }),
        )
      } catch (error) {
        writeError(res, 400, 'save-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return () => undefined
}
