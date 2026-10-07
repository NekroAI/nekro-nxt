import { CommunityPersonaIdSchema, HostApiContracts, type AgentId } from '@nekro-nxt/contracts'
import type { ServerResponse } from 'node:http'
import { CommunityError } from './community.js'
import { CommunityPersonaService, installCommunityPersona, type PersonaInstallTarget } from './community-personas.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

const failure = (res: ServerResponse, error: unknown, fallbackCode: string): void => {
  if (error instanceof CommunityError) {
    writeError(res, error.status, error.code, error.message)
    return
  }
  writeError(res, 400, fallbackCode, error instanceof Error ? error.message : String(error))
}

/**
 * 社区人设：浏览、详情、头像代理、安装为智能体或替换现有智能体的设定、我的人设与发布。
 * 页面只读取本机代理的头像，不直接跨域访问社区图片。
 */
export function registerCommunityPersonaRoutes({ runtime, registerRoute, projections }: HostRouteContext): void {
  const personas = new CommunityPersonaService(runtime.community, runtime.repository)
  const installTarget: PersonaInstallTarget = {
    defaultCapabilities: async () => ({
      subagents: true,
      fileTools: false,
      webSearch: (await runtime.host.getWebSearchCapabilityStatus()).available,
      dynamicCreation: false,
      developmentShell: false,
      unrestrictedFileAccess: false,
      scheduledTasks: true,
    }),
    createAgent: async (content) => {
      const entity = await runtime.createAgentWithInternalChannel(content)
      return { agentId: entity.agentId, channelId: entity.channelId }
    },
    currentRevision: (agentId: AgentId) => {
      const revision = runtime.repository.getAgent(agentId)?.revision
      return revision
        ? {
            id: revision.id,
            displayName: revision.displayName,
            persona: revision.persona,
            personaDocument: revision.personaDocument,
            model: revision.model,
            capabilities: revision.capabilities,
            imagePolicy: revision.imagePolicy,
            dynamicClientApprovalPolicy: revision.dynamicClientApprovalPolicy,
          }
        : undefined
    },
    reviseAgent: (agentId, expected, content) => runtime.core.reviseAgent(agentId, expected, content).revision.id,
    uploadAvatar: (agentId, bytes) => projections.uploadAvatar(agentId, bytes),
  }

  registerRoute({
    kind: 'exact',
    path: '/api/community/personas',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        const search = new URL(req.url ?? '/', 'http://localhost').searchParams
        const params = HostApiContracts.listCommunityPersonas.parseParams(
          Object.fromEntries(
            ['query', 'tag', 'official', 'cursor'].flatMap((key) => {
              const value = search.get(key)
              return value ? [[key, value]] : []
            }),
          ),
        )
        writeContractJson(res, 200, HostApiContracts.listCommunityPersonas, await personas.list(params))
      } catch (error) {
        failure(res, error, 'community-request-failed')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/mine/personas',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.listCommunityMyPersonas, await personas.mine())
      } catch (error) {
        failure(res, error, 'community-request-failed')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/personas/publish',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const input = HostApiContracts.publishCommunityPersona.parseRequest(await readJsonBody(req))
        if (!runtime.repository.getAgent(input.agentId)) {
          writeError(res, 404, 'not-found', '智能体不存在或已被删除。')
          return
        }
        writeContractJson(res, 200, HostApiContracts.publishCommunityPersona, await personas.publish(input))
      } catch (error) {
        failure(res, error, 'community-publish-failed')
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/community/personas',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/community\/personas\/([^/]+)(?:\/(avatar|install))?$/u.exec(url.pathname)
      const parsedId = CommunityPersonaIdSchema.safeParse(decodeURIComponent(match?.[1] ?? ''))
      if (!match || !parsedId.success) {
        writeError(res, 404, 'not-found', '接口不存在。')
        return
      }
      const personaId = parsedId.data
      try {
        if (match[2] === undefined) {
          if (req.method !== 'GET') {
            writeError(res, 405, 'method-not-allowed', '只支持 GET。')
            return
          }
          writeContractJson(res, 200, HostApiContracts.getCommunityPersona, await personas.get(personaId))
          return
        }
        if (match[2] === 'avatar') {
          if (req.method !== 'GET') {
            writeError(res, 405, 'method-not-allowed', '只支持 GET。')
            return
          }
          const version = url.searchParams.get('v')
          const avatar = await personas.avatar(personaId, version)
          res.writeHead(200, {
            'content-type': avatar.mediaType,
            'content-length': String(avatar.bytes.byteLength),
            // 带版本的地址内容不变，可以缓存；不带版本时每次向社区确认。
            'cache-control': version ? 'private, max-age=86400' : 'private, no-cache',
            'content-security-policy': "default-src 'none'",
            'x-content-type-options': 'nosniff',
          })
          res.end(avatar.bytes)
          return
        }
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        const input = HostApiContracts.installCommunityPersona.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.installCommunityPersona,
          await installCommunityPersona(personas, installTarget, personaId, input),
        )
      } catch (error) {
        failure(res, error, match[2] === 'install' ? 'community-persona-install-failed' : 'community-request-failed')
      }
    },
  })
}
