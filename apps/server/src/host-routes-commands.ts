import { ChannelIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import { viewerKeyFromRequest } from './viewer.js'

/**
 * Mount ONLY on the management Host: authenticated edge upstream or trusted local console.
 * viewerKeyFromRequest identifies an already trusted viewer; it does not authenticate a request.
 * Never register these routes on a public/adapter-facing Host API or accept identity in JSON.
 */
export function registerManagementCommandRoutes({ runtime, registerRoute }: HostRouteContext): void {
  registerRoute({
    kind: 'prefix',
    path: '/api/commands',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const viewerId = viewerKeyFromRequest(req)
      try {
        if (req.method === 'GET' && url.pathname === '/api/commands') {
          const value = url.searchParams.get('channelId')
          const channelId = value === null ? undefined : ChannelIdSchema.parse(value)
          const problems = runtime.repository.listActivations().flatMap((activation) => {
            if (channelId !== undefined && runtime.repository.getBinding(channelId)?.agentId !== activation.agentId)
              return []
            const d = runtime.extensions.getAttachmentDiagnostic(activation.agentId, activation.extensionId)
            return d?.status === 'active' || d === undefined
              ? []
              : [
                  `${runtime.repository.getExtension(activation.extensionId)?.displayName ?? '扩展'}：${d.message ?? d.status}`,
                ]
          })
          writeContractJson(res, 200, HostApiContracts.listCommands, {
            commands: runtime.commands.catalog(channelId, { source: 'web', displayName: 'Web 管理员', viewerId }),
            problems,
            settings: runtime.commands.settings(),
            ...(channelId === undefined ? {} : { channel: runtime.commands.channelSettings(channelId) }),
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/commands/execute') {
          const body = HostApiContracts.executeCommand.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.executeCommand,
            await runtime.commands.executeWeb(body.channelId, body.text, body.requestId, viewerId),
          )
          return
        }
        if (req.method === 'PUT' && url.pathname === '/api/commands/policy') {
          const body = HostApiContracts.setCommandPolicy.parseRequest(await readJsonBody(req))
          runtime.commands.setPolicy(body.scope, body.name, body.policy)
          writeContractJson(res, 200, HostApiContracts.setCommandPolicy, { saved: true })
          return
        }
        if (req.method === 'PUT' && url.pathname === '/api/commands/settings') {
          const body = HostApiContracts.setCommandSettings.parseRequest(await readJsonBody(req))
          runtime.commands.setUnauthorizedFeedback(body.unauthorizedFeedback)
          writeContractJson(res, 200, HostApiContracts.setCommandSettings, { saved: true })
          return
        }
        if (req.method === 'PUT' && url.pathname === '/api/commands/channel-settings') {
          const body = HostApiContracts.setCommandChannelSettings.parseRequest(await readJsonBody(req))
          runtime.commands.setBareCommands(body.channelId, body.bareCommands)
          writeContractJson(res, 200, HostApiContracts.setCommandChannelSettings, { saved: true })
          return
        }
        if (req.method === 'PUT' && url.pathname === '/api/commands/grants') {
          const body = HostApiContracts.setCommandGrant.parseRequest(await readJsonBody(req))
          runtime.commands.grant(body.channelId, body.identityId, body.enabled)
          writeContractJson(res, 200, HostApiContracts.setCommandGrant, { saved: true })
          return
        }
        const members = /^\/api\/commands\/members\/([^/]+)$/u.exec(url.pathname)
        if (req.method === 'GET' && members) {
          const channelId = ChannelIdSchema.parse(decodeURIComponent(members[1]!))
          writeContractJson(res, 200, HostApiContracts.listCommandMembers, {
            members: runtime.commands.members(channelId),
          })
          return
        }
        const execution = /^\/api\/commands\/executions\/([^/]+)$/u.exec(url.pathname)
        if (req.method === 'GET' && execution) {
          const record = runtime.repository.commands.get(decodeURIComponent(execution[1]!))
          if (!record) {
            writeError(res, 404, 'not-found', '命令执行记录不存在。')
            return
          }
          writeContractJson(res, 200, HostApiContracts.getCommandExecution, record)
          return
        }
        writeError(res, 404, 'not-found', '未定义的命令接口。')
      } catch (error) {
        writeError(res, 400, 'command-request-failed', error instanceof Error ? error.message : '命令请求失败。')
      }
    },
  })
}
