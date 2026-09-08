import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  HostPageContributionSchema,
  JsonValueSchema,
  type AgentId,
  type HostUiPermission,
} from '@nekro-nxt/contracts'
import { scopeHostUiCss, validateHostUiSvg } from '@nekro-nxt/extension-runtime'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { DEEPSEEK_HARNESS_VERSION } from './dsh-version.js'
import {
  assertAuxiliaryImageModel,
  buildSnapshotMessage,
  createExtensionRevisionExport,
  HOST_UI_PRODUCT_MUTATIONS,
  parseExtensionImport,
  projectDshPlugins,
  readBinaryBody,
  readJsonBody,
  writeContractJson,
  writeDownload,
  writeError,
  writeJson,
  type HostRouteContext,
  type ParsedExtensionImport,
} from './host-route-support.js'
import { performHostUiNetworkRequest } from './host-ui-network.js'
export function registerExtensionsRoutes({
  runtime,
  registerRoute,
  broadcast,
  broadcastExtensionsChanged,
}: HostRouteContext): () => void {
  const pendingExtensionImports = new Map<
    string,
    { readonly parsed: ParsedExtensionImport; readonly expiresAt: number }
  >()
  const pendingHostUiCredentials = new Map<
    string,
    {
      readonly ownerKey: string
      readonly adapterKey: string
      readonly credentials: Readonly<Record<string, string>>
      readonly expiresAt: number
    }
  >()
  const pruneExpiredHostUiCredentials = (now = Date.now()): void => {
    for (const [token, pending] of pendingHostUiCredentials) {
      if (pending.expiresAt <= now) pendingHostUiCredentials.delete(token)
    }
  }
  const pruneExpiredExtensionImports = (now = Date.now()): void => {
    for (const [token, pending] of pendingExtensionImports) {
      if (pending.expiresAt <= now) pendingExtensionImports.delete(token)
    }
  }
  registerRoute({
    kind: 'prefix',
    path: '/api/host-ui',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/host-ui/page-preferences') {
        if (req.method !== 'PUT') {
          writeError(res, 405, 'method-not-allowed', '页面入口偏好只支持 PUT。')
          return
        }
        try {
          const input = HostApiContracts.updateHostUiPagePreferences.parseRequest(await readJsonBody(req))
          const revision = runtime.updateHostUiPagePreferences(input)
          writeContractJson(res, 200, HostApiContracts.updateHostUiPagePreferences, { revision })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 409, 'host-ui-preference-conflict', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const pageMatch = /^\/api\/host-ui\/pages\/([^/]+)\/(call|diagnostic)$/u.exec(url.pathname)
      if (!pageMatch) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      const page = runtime.repository
        .listHostUiPageEntries()
        .find(({ pageInstanceId }) => pageInstanceId === decodeURIComponent(pageMatch[1] ?? ''))
      if (!page) {
        writeError(res, 404, 'host-ui-page-missing', '页面入口不存在或已撤销。')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '页面 Runtime 端点只支持 POST。')
        return
      }
      if (pageMatch[2] === 'call') {
        try {
          HostApiContracts.callHostUiPage.parseParams({ pageInstanceId: page.pageInstanceId })
          const input = HostApiContracts.callHostUiPage.parseRequest(await readJsonBody(req))
          const ownerKey =
            page.owner.kind === 'extension' ? `extension:${page.owner.extensionId}` : `dsh:${page.owner.entryId}`
          const grant = runtime.repository.getHostUiPermissionGrant(ownerKey)
          const artifactDigest =
            page.owner.kind === 'extension'
              ? runtime.repository.getExtensionRevision(page.owner.revisionId)?.payloadDigest
              : page.owner.artifactDigest
          if (!grant || grant.artifactDigest !== artifactDigest) throw new Error('页面权限批准已失效。')
          const permissionByMethod: ReadonlyMap<string, HostUiPermission> = new Map([
            ['agents.list', 'agents.read'],
            ['agents.create', 'agents.manage'],
            ['agents.revise', 'agents.manage'],
            ['agents.capabilities', 'agents.manage'],
            ['channels.list', 'channels.read'],
            ['channels.create', 'channels.manage'],
            ['channels.rename', 'channels.manage'],
            ['channels.bind', 'channels.manage'],
            ['channels.unbind', 'channels.manage'],
            ['connections.list', 'connections.read'],
            ['connections.create', 'connections.manage'],
            ['connections.rename', 'connections.manage'],
            ['connections.test', 'connections.manage'],
            ['credentials.write', 'credentials.write'],
            ['extensions.list', 'extensions.read'],
            ['dsh-plugins.list', 'dsh-plugins.read'],
            ['runtime.list', 'runtime.read'],
            ['messages.list', 'messages.read'],
            ['messages.send', 'messages.send'],
            ['assets.get', 'assets.read'],
            ['notifications.publish', 'notifications.publish'],
            ['network.request', 'network.request'],
          ])
          const topicPermission: ReadonlyMap<string, HostUiPermission> = new Map([
            ['agents', 'agents.read'],
            ['channels', 'channels.read'],
            ['connections', 'connections.read'],
            ['extensions', 'extensions.read'],
            ['dsh-plugins', 'dsh-plugins.read'],
            ['runtime', 'runtime.read'],
            ['messages', 'messages.read'],
          ])
          const eventRequest =
            input.method === 'events.subscribe'
              ? z
                  .object({
                    topic: z.enum([
                      'agents',
                      'channels',
                      'connections',
                      'extensions',
                      'dsh-plugins',
                      'runtime',
                      'messages',
                    ]),
                  })
                  .strict()
                  .parse(input.input)
              : undefined
          const requiredPermission =
            eventRequest === undefined ? permissionByMethod.get(input.method) : topicPermission.get(eventRequest.topic)
          let value
          if (requiredPermission) {
            if (!grant?.declaration.permissions.includes(requiredPermission)) {
              throw new Error(`页面未获得 ${requiredPermission} 权限。`)
            }
            if (input.method === 'agents.list') {
              value = runtime.core.listAgents().map((agent) => ({
                id: agent.definition.id,
                displayName: agent.revision.displayName,
                currentRevisionId: agent.revision.id,
              }))
            } else if (input.method === 'agents.create') {
              const parsed = HostApiContracts.createAgent.parseRequest(input.input)
              const capabilities =
                parsed.capabilities ??
                ({
                  subagents: true,
                  fileTools: false,
                  webSearch: (await runtime.host.getWebSearchCapabilityStatus()).available,
                  dynamicCreation: false,
                  developmentShell: false,
                  unrestrictedFileAccess: false,
                } as const)
              await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
              const entity = await runtime.createAgentWithInternalChannel({
                displayName: parsed.displayName,
                persona: parsed.persona,
                ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
                model: parsed.model,
                capabilities,
                ...(parsed.imagePolicy === undefined ? {} : { imagePolicy: parsed.imagePolicy }),
                ...(parsed.dynamicClientApprovalPolicy === undefined
                  ? {}
                  : { dynamicClientApprovalPolicy: parsed.dynamicClientApprovalPolicy }),
              })
              value = { agentId: entity.agentId, channelId: entity.channelId, connectionId: entity.connectionId }
            } else if (input.method === 'agents.revise') {
              const request = z.object({ agentId: AgentIdSchema, revision: z.unknown() }).strict().parse(input.input)
              const parsed = HostApiContracts.reviseAgent.parseRequest(request.revision)
              const current = runtime.repository.getAgent(request.agentId)
              if (!current || current.revision.id !== parsed.expectedCurrentRevisionId) {
                throw new Error('智能体配置已更新。')
              }
              await assertAuxiliaryImageModel(runtime, parsed.imagePolicy)
              const updated = runtime.core.reviseAgent(request.agentId, current.revision.id, {
                displayName: parsed.displayName,
                persona: parsed.persona,
                ...(parsed.personaDocument === undefined ? {} : { personaDocument: parsed.personaDocument }),
                model: parsed.model,
                capabilities: current.revision.capabilities,
                imagePolicy: parsed.imagePolicy ?? current.revision.imagePolicy,
                dynamicClientApprovalPolicy:
                  parsed.dynamicClientApprovalPolicy ?? current.revision.dynamicClientApprovalPolicy,
              })
              value = { currentRevisionId: updated.revision.id }
            } else if (input.method === 'agents.capabilities') {
              const request = z
                .object({ agentId: AgentIdSchema, capabilities: z.unknown() })
                .strict()
                .parse(input.input)
              const parsed = HostApiContracts.updateAgentCapabilities.parseRequest(request.capabilities)
              const current = runtime.repository.getAgent(request.agentId)
              if (!current) throw new Error('智能体不存在。')
              const capabilities = {
                ...current.revision.capabilities,
                ...(parsed.subagents === undefined ? {} : { subagents: parsed.subagents }),
                ...(parsed.fileTools === undefined ? {} : { fileTools: parsed.fileTools }),
                ...(parsed.webSearch === undefined ? {} : { webSearch: parsed.webSearch }),
                ...(parsed.dynamicCreation === undefined ? {} : { dynamicCreation: parsed.dynamicCreation }),
                ...(parsed.developmentShell === undefined ? {} : { developmentShell: parsed.developmentShell }),
                ...(parsed.unrestrictedFileAccess === undefined
                  ? {}
                  : { unrestrictedFileAccess: parsed.unrestrictedFileAccess }),
              }
              const updated = runtime.core.reviseAgent(request.agentId, current.revision.id, {
                displayName: current.revision.displayName,
                persona: current.revision.persona,
                personaDocument: current.revision.personaDocument,
                model: current.revision.model,
                capabilities,
                imagePolicy: current.revision.imagePolicy,
                dynamicClientApprovalPolicy: current.revision.dynamicClientApprovalPolicy,
              })
              value = { currentRevisionId: updated.revision.id, capabilities: updated.revision.capabilities }
            } else if (input.method === 'connections.list') {
              value = runtime.core.listConnections().map((connection) => ({
                id: connection.id,
                adapterKey: connection.adapterKey,
                ...(connection.alias === undefined ? {} : { alias: connection.alias }),
              }))
            } else if (input.method === 'credentials.write') {
              pruneExpiredHostUiCredentials()
              const request = z
                .object({
                  adapterKey: z.string().trim().min(1).max(120),
                  values: z.record(
                    z.string(),
                    z
                      .string()
                      .min(1)
                      .max(16 * 1024),
                  ),
                })
                .strict()
                .parse(input.input)
              const descriptor = runtime.adapters.get(request.adapterKey)?.descriptor
              if (descriptor?.provisioning !== 'user-created') throw new Error('这个 Adapter 不能创建用户连接。')
              for (const key of Object.keys(request.values)) {
                if (descriptor.configSchema.properties[key]?.type !== 'credential-reference') {
                  throw new Error(`连接凭据包含未知字段：${key}`)
                }
              }
              const token = randomUUID()
              pendingHostUiCredentials.set(token, {
                ownerKey,
                adapterKey: request.adapterKey,
                credentials: request.values,
                expiresAt: Date.now() + 5 * 60_000,
              })
              value = { token, fields: Object.keys(request.values) }
            } else if (input.method === 'connections.create') {
              pruneExpiredHostUiCredentials()
              const request = z
                .object({
                  adapterKey: z.string().trim().min(1).max(120),
                  alias: z.string().trim().max(80).optional(),
                  configuration: z.record(z.string(), JsonValueSchema).default({}),
                  credentialToken: z.string().uuid().optional(),
                })
                .strict()
                .parse(input.input)
              const pending = request.credentialToken
                ? pendingHostUiCredentials.get(request.credentialToken)
                : undefined
              if (request.credentialToken && !pending) throw new Error('连接凭据提交不存在或已经使用。')
              if (
                pending &&
                (pending.ownerKey !== ownerKey ||
                  pending.adapterKey !== request.adapterKey ||
                  pending.expiresAt < Date.now())
              ) {
                pendingHostUiCredentials.delete(request.credentialToken!)
                throw new Error('连接凭据提交已失效。')
              }
              const connection = await runtime.createConnection({
                adapterKey: request.adapterKey,
                ...(request.alias === undefined ? {} : { alias: request.alias }),
                configuration: request.configuration,
                credentials: pending?.credentials ?? {},
              })
              if (request.credentialToken) pendingHostUiCredentials.delete(request.credentialToken)
              value = { connectionId: connection.id, adapterKey: connection.adapterKey }
            } else if (input.method === 'connections.rename') {
              const request = z
                .object({ connectionId: ConnectionIdSchema, alias: z.string().trim().max(80).optional() })
                .strict()
                .parse(input.input)
              const connection = runtime.updateConnectionAlias(request.connectionId, request.alias)
              value = {
                connectionId: connection.id,
                ...(connection.alias === undefined ? {} : { alias: connection.alias }),
              }
            } else if (input.method === 'connections.test') {
              const request = z
                .object({
                  connectionId: ConnectionIdSchema,
                  direction: z.enum(['send', 'receive']),
                  channelId: ChannelIdSchema.optional(),
                })
                .strict()
                .parse(input.input)
              value = await runtime.testConnection(request.connectionId, request.direction, request.channelId)
            } else if (input.method === 'channels.list') {
              value = runtime.core.listConnections().flatMap((connection) =>
                runtime.core.listChannelsByConnection(connection.id).map((channel) => ({
                  id: channel.id,
                  connectionId: connection.id,
                  kind: channel.kind,
                  ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
                })),
              )
            } else if (input.method === 'channels.create') {
              const parsed = HostApiContracts.createInternalChannel.parseRequest(input.input)
              const channel = runtime.core.createChannel({
                connectionId: runtime.internalConnectionId,
                platformChannelId: `host-ui-${randomUUID()}`,
                kind: 'internal',
                displayName: parsed.displayName,
              })
              value = { channelId: channel.id, connectionId: channel.connectionId }
            } else if (input.method === 'channels.rename') {
              const request = z
                .object({ channelId: ChannelIdSchema, displayName: z.string() })
                .strict()
                .parse(input.input)
              const parsed = HostApiContracts.renameChannel.parseRequest({ displayName: request.displayName })
              const channel = runtime.core.updateChannelDisplayName(request.channelId, parsed.displayName)
              value = { channelId: channel.id, displayName: channel.displayName }
            } else if (input.method === 'channels.bind') {
              const parsed = HostApiContracts.createBinding.parseRequest(input.input)
              value = await runtime.channels.replaceBinding({
                channelId: parsed.channelId,
                agentId: parsed.agentId,
                triggerPolicy: parsed.triggerPolicy,
                ...(parsed.processingFeedback === undefined ? {} : { processingFeedback: parsed.processingFeedback }),
                ...(parsed.activityTriggerOverrides === undefined
                  ? {}
                  : { activityTriggerOverrides: parsed.activityTriggerOverrides }),
              })
            } else if (input.method === 'channels.unbind') {
              const request = z.object({ channelId: ChannelIdSchema }).strict().parse(input.input)
              await runtime.channels.clearBinding(request.channelId)
              value = { channelId: request.channelId, cleared: true }
            } else if (input.method === 'extensions.list') {
              value = runtime.repository.listExtensions().map((extension) => ({
                id: extension.id,
                scope: extension.scope,
                displayName: extension.displayName,
                description: extension.description,
              }))
            } else if (input.method === 'dsh-plugins.list') {
              value = projectDshPlugins(runtime)
            } else if (input.method === 'runtime.list') {
              value = runtime.repository.listRecoverableEpisodes().map((episode) => ({
                id: episode.id,
                agentId: episode.agentId,
                channelId: episode.channelId,
                status: episode.status,
              }))
            } else if (input.method === 'messages.list') {
              const request = z
                .object({ channelId: ChannelIdSchema, limit: z.number().int().min(1).max(100).default(50) })
                .strict()
                .parse(input.input)
              value = buildSnapshotMessage(runtime, request.channelId, { limit: request.limit })
            } else if (input.method === 'messages.send') {
              const request = z.object({ channelId: ChannelIdSchema, message: z.unknown() }).strict().parse(input.input)
              const message = HostApiContracts.sendChannelMessage.parseRequest(request.message)
              const channel = runtime.repository.getChannel(request.channelId)
              if (!channel) throw new Error('频道不存在。')
              if (channel.kind === 'internal') {
                value = await runtime.internalChannel.postMessage({
                  channelId: request.channelId,
                  clientEventId: message.clientEventId ?? `host-ui-${Date.now()}`,
                  parts: message.parts,
                  ...(message.senderMemberId === undefined ? {} : { senderMemberId: message.senderMemberId }),
                })
              } else {
                if (!runtime.repository.getBinding(request.channelId)) throw new Error('频道尚未绑定智能体。')
                const connection = runtime.repository.getConnection(channel.connectionId)
                if (!connection || runtime.connectionCapabilities(connection.id)?.outbound.proactiveSend !== true) {
                  throw new Error('这个连接不允许主动发言。')
                }
                await runtime.channels.sendAdminConsoleMessage({
                  channelId: request.channelId,
                  parts: message.parts,
                  ...(message.clientEventId === undefined ? {} : { clientRequestId: message.clientEventId }),
                })
                value = { inserted: true }
              }
            } else if (input.method === 'assets.get') {
              const request = z
                .object({ channelId: ChannelIdSchema, assetId: AssetIdSchema })
                .strict()
                .parse(input.input)
              if (!runtime.repository.canAccessAsset(request.assetId, request.channelId)) {
                throw new Error('当前频道无法访问该资源。')
              }
              const asset = runtime.repository.getAssetById(request.assetId)
              if (!asset) throw new Error('资源不存在。')
              value = {
                assetId: asset.id,
                mediaType: asset.mediaType,
                byteSize: asset.byteSize,
                url: `/api/channels/${encodeURIComponent(request.channelId)}/assets/${encodeURIComponent(request.assetId)}`,
              }
            } else if (input.method === 'notifications.publish') {
              const request = z
                .object({ title: z.string(), body: z.string(), route: z.string().optional() })
                .strict()
                .parse(input.input)
              runtime.notifications.publishExtensionNotification({
                owner: ownerKey,
                title: request.title,
                body: request.body,
                ...(request.route === undefined ? {} : { route: request.route }),
              })
              value = { published: true }
            } else if (input.method === 'network.request') {
              value = await performHostUiNetworkRequest(input.input, grant.declaration.networkOrigins)
            } else {
              value = { subscribed: true, topic: eventRequest?.topic }
            }
            value = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))
          } else if (input.method === 'state.get' || input.method === 'state.set' || input.method === 'state.delete') {
            const settingKey = `host-ui-state:${createHash('sha256').update(ownerKey).digest('hex')}`
            const current = runtime.repository.getSystemSetting(settingKey)
            const document = z.record(z.string(), JsonValueSchema).parse(current?.value ?? {})
            if (input.method === 'state.get') {
              const request = z
                .object({ key: z.string().trim().min(1).max(120) })
                .strict()
                .parse(input.input)
              value = { revision: current?.revision ?? 0, value: document[request.key] ?? null }
            } else {
              const request = z
                .object({
                  key: z.string().trim().min(1).max(120),
                  expectedRevision: z.number().int().nonnegative(),
                  value: JsonValueSchema.optional(),
                })
                .strict()
                .parse(input.input)
              if ((current?.revision ?? 0) !== request.expectedRevision) throw new Error('扩展状态已更新。')
              const next = { ...document }
              if (input.method === 'state.delete') delete next[request.key]
              else next[request.key] = request.value ?? null
              if (Object.keys(next).length > 128 || JSON.stringify(next).length > 64 * 1024) {
                throw new Error('扩展状态超过 128 项或 64 KiB。')
              }
              const saved = runtime.repository.putSystemSetting(settingKey, next, current?.revision, Date.now())
              value = { revision: saved.revision }
            }
          } else {
            if (page.owner.kind !== 'extension') throw new Error('DSH 页面没有注册自定义 Host RPC。')
            value = await runtime.installation.callHostUi(page.owner.extensionId, input.method, input.input)
          }
          writeContractJson(res, 200, HostApiContracts.callHostUiPage, { value })
          if (HOST_UI_PRODUCT_MUTATIONS.has(input.method)) {
            broadcast({ event: 'snapshot-changed', data: { changed: true } })
          }
        } catch (error) {
          runtime.repository.upsertHostUiDiagnostic({
            pageInstanceId: page.pageInstanceId,
            status: 'rpc-failed',
            message: error instanceof Error ? error.message : String(error),
            observedAt: Date.now(),
          })
          writeError(res, 400, 'host-ui-call-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      try {
        const input = HostApiContracts.reportHostUiPageDiagnostic.parseRequest(await readJsonBody(req))
        runtime.repository.upsertHostUiDiagnostic({
          pageInstanceId: page.pageInstanceId,
          status: input.status,
          ...(input.message === undefined ? {} : { message: input.message }),
          observedAt: Date.now(),
        })
        writeContractJson(res, 200, HostApiContracts.reportHostUiPageDiagnostic, { recorded: true })
        broadcastExtensionsChanged()
      } catch (error) {
        writeError(res, 400, 'host-ui-diagnostic-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/extensions',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const deleteMatch = /^\/api\/extensions\/([^/]+)$/u.exec(url.pathname)
      if (deleteMatch) {
        if (req.method !== 'DELETE') {
          writeError(res, 405, 'method-not-allowed', '删除本地扩展只支持 DELETE。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(deleteMatch[1] ?? ''))
          HostApiContracts.deleteLocalExtension.parseRequest(undefined)
          await runtime.deleteLocalExtension(extensionId)
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.deleteLocalExtension, { deleted: true })
        } catch (error) {
          writeError(res, 400, 'extension-delete-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (url.pathname === '/api/extensions/imports/inspect') {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '检查扩展导入包只支持 POST。')
          return
        }
        try {
          pruneExpiredExtensionImports()
          const parsed = parseExtensionImport(await readBinaryBody(req, 16 * 1024 * 1024))
          const existingRevision = runtime.repository.getExtensionRevision(parsed.manifest.revision.id)
          if (
            existingRevision &&
            (existingRevision.extensionId !== parsed.manifest.extension.id ||
              existingRevision.contentDigest !== parsed.manifest.revision.contentDigest ||
              existingRevision.payloadDigest !== parsed.manifest.revision.payloadDigest)
          ) {
            throw new Error('相同 Extension/Revision 身份已存在，但内容不同；不会覆盖本地版本。')
          }
          const token = randomUUID()
          pendingExtensionImports.set(token, { parsed, expiresAt: Date.now() + 10 * 60_000 })
          const slugOwner = runtime.repository.getExtensionBySlug(parsed.manifest.extension.slug)
          writeContractJson(res, 200, HostApiContracts.inspectExtensionImport, {
            token,
            extensionId: parsed.manifest.extension.id,
            revisionId: parsed.manifest.revision.id,
            slug: parsed.manifest.extension.slug,
            displayName: parsed.manifest.extension.displayName,
            scope: parsed.manifest.extension.scope,
            idempotent: existingRevision !== undefined,
            slugConflict: slugOwner !== undefined && slugOwner.id !== parsed.manifest.extension.id,
          })
        } catch (error) {
          writeError(
            res,
            400,
            'extension-import-inspect-failed',
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      const importCommitMatch = /^\/api\/extensions\/imports\/([^/]+)\/commit$/u.exec(url.pathname)
      if (importCommitMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '提交扩展导入只支持 POST。')
          return
        }
        try {
          pruneExpiredExtensionImports()
          const token = decodeURIComponent(importCommitMatch[1] ?? '')
          const params = HostApiContracts.commitExtensionImport.parseParams({ token })
          const input = HostApiContracts.commitExtensionImport.parseRequest(await readJsonBody(req))
          const pending = pendingExtensionImports.get(params.token)
          if (!pending) throw new Error('扩展导入检查已失效，请重新选择文件。')
          const result = await runtime.extensionService.importRevision({
            extension: pending.parsed.manifest.extension,
            revision: pending.parsed.manifest.revision,
            manifest: pending.parsed.revisionManifest,
            sources: pending.parsed.sources,
            resources: pending.parsed.resources,
            dshVersion: DEEPSEEK_HARNESS_VERSION,
            ...(input.localSlug === undefined ? {} : { localSlug: input.localSlug }),
          })
          pendingExtensionImports.delete(params.token)
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.commitExtensionImport, {
            extensionId: result.extension.id,
            revisionId: result.revision.id,
            idempotent: result.idempotent,
          })
        } catch (error) {
          writeError(res, 400, 'extension-import-commit-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const exportMatch = /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/export$/u.exec(url.pathname)
      if (exportMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '导出扩展版本只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(exportMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(exportMatch[2] ?? ''))
          const exported = await createExtensionRevisionExport(runtime, extensionId, revisionId)
          writeDownload(res, exported.filename, exported.body)
        } catch (error) {
          writeError(res, 400, 'extension-export-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const installationMatch = /^\/api\/extensions\/([^/]+)\/installation$/u.exec(url.pathname)
      if (installationMatch) {
        let extensionId: z.output<typeof ExtensionIdSchema>
        try {
          extensionId = ExtensionIdSchema.parse(decodeURIComponent(installationMatch[1] ?? ''))
        } catch {
          writeError(res, 400, 'invalid-extension', '无效的扩展 ID。')
          return
        }
        if (req.method === 'PUT') {
          try {
            const params = HostApiContracts.installHostExtension.parseParams({ extensionId })
            const parsed = HostApiContracts.installHostExtension.parseRequest(await readJsonBody(req))
            const installation = await runtime.installHostExtension({
              extensionId: params.extensionId,
              revisionId: parsed.revisionId,
              ...(parsed.permissionApproval === undefined ? {} : { permissionApproval: parsed.permissionApproval }),
            })
            writeContractJson(res, 200, HostApiContracts.installHostExtension, { installation })
            broadcastExtensionsChanged()
          } catch (error) {
            writeError(res, 400, 'installation-failed', error instanceof Error ? error.message : String(error))
          }
          return
        }
        if (req.method === 'DELETE') {
          try {
            const params = HostApiContracts.uninstallHostExtension.parseParams({ extensionId })
            HostApiContracts.uninstallHostExtension.parseRequest(undefined)
            await runtime.uninstallHostExtension(params.extensionId)
            writeContractJson(res, 200, HostApiContracts.uninstallHostExtension, { uninstalled: true })
            broadcastExtensionsChanged()
          } catch (error) {
            writeError(res, 400, 'uninstall-failed', error instanceof Error ? error.message : String(error))
          }
          return
        }
        writeError(res, 405, 'method-not-allowed', '本机扩展安装只支持 PUT/DELETE。')
        return
      }
      const hostUiClientMatch =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/host-ui\/client\/([a-f0-9]{64})\.(mjs|css)$/u.exec(
          url.pathname,
        )
      if (hostUiClientMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '页面 Client Artifact 只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(hostUiClientMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(hostUiClientMatch[2] ?? ''))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) throw new Error('该扩展版本未安装到本机。')
          const revision = runtime.repository.getExtensionRevision(revisionId)
          if (!revision || revision.extensionId !== extensionId) throw new Error('找不到页面扩展版本。')
          const artifact = await runtime.extensionService.buildRevision(revision)
          if (!artifact.clientEntry || artifact.buildKey !== hostUiClientMatch[3]) {
            throw new Error('页面 Client buildKey 已过期。')
          }
          const css = hostUiClientMatch[4] === 'css'
          const source = css
            ? artifact.clientCssEntry
              ? await readFile(artifact.clientCssEntry, 'utf8')
              : ''
            : await readFile(artifact.clientEntry, 'utf8')
          res.writeHead(200, {
            'content-type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(css ? scopeHostUiCss(source, artifact.buildKey) : source)
        } catch (error) {
          writeError(res, 409, 'host-ui-client-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const hostUiAssetMatch =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/host-ui\/assets\/([a-f0-9]{64})\.svg$/u.exec(url.pathname)
      if (hostUiAssetMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '页面图标只支持 GET。')
          return
        }
        try {
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(hostUiAssetMatch[1] ?? ''))
          const revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(hostUiAssetMatch[2] ?? ''))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) throw new Error('该扩展版本未安装到本机。')
          const revision = runtime.repository.getExtensionRevision(revisionId)
          if (!revision || revision.extensionId !== extensionId) throw new Error('找不到页面扩展版本。')
          const sourceDirectory = runtime.extensionService.revisionSourceDirectory(revision)
          const manifest = z
            .object({ contributions: z.array(z.unknown()) })
            .passthrough()
            .parse(JSON.parse(await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8')))
          const page = manifest.contributions
            .map((candidate) => HostPageContributionSchema.safeParse(candidate))
            .find(
              (candidate) =>
                candidate.success &&
                candidate.data.icon.kind === 'svg' &&
                candidate.data.icon.sha256 === hostUiAssetMatch[3],
            )
          if (!page?.success || page.data.icon.kind !== 'svg') throw new Error('页面图标不存在。')
          const source = await readFile(path.join(sourceDirectory, page.data.icon.path), 'utf8')
          if (createHash('sha256').update(source).digest('hex') !== page.data.icon.sha256) {
            throw new Error('页面图标摘要不一致。')
          }
          validateHostUiSvg(source)
          res.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'host-ui-icon-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match =
        /^\/api\/extensions\/([^/]+)\/revisions\/([^/]+)\/(call|client-diagnostic|host-client-diagnostic|client\/([a-f0-9]{64})\.mjs)$/u.exec(
          url.pathname,
        )
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let extensionId: z.output<typeof ExtensionIdSchema>
      let revisionId: z.output<typeof ExtensionRevisionIdSchema>
      try {
        extensionId = ExtensionIdSchema.parse(decodeURIComponent(match[1] ?? ''))
        revisionId = ExtensionRevisionIdSchema.parse(decodeURIComponent(match[2] ?? ''))
      } catch {
        writeError(res, 400, 'invalid-extension-client-target', '无效的扩展或 Revision ID。')
        return
      }
      const revision = runtime.repository.getExtensionRevision(revisionId)
      if (!revision || revision.extensionId !== extensionId) {
        writeError(res, 404, 'extension-revision-missing', '找不到指定的扩展 Revision。')
        return
      }
      const action = match[3]
      if (action?.startsWith('client/')) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'Client Artifact 只支持 GET。')
          return
        }
        const verification = runtime.repository.getExtensionRevisionVerification(revisionId)
        if (verification?.scope === 'host-adapter') {
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) {
            writeError(res, 409, 'stale-client-build', '该 Revision 不是当前安装到本机的版本。')
            return
          }
        } else {
          let agentId: AgentId
          try {
            agentId = AgentIdSchema.parse(url.searchParams.get('agentId'))
          } catch {
            writeError(res, 400, 'invalid-agent', 'Client Artifact 缺少有效的智能体 ID。')
            return
          }
          const activation = runtime.repository.getActivation(agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) {
            writeError(res, 409, 'stale-client-build', '该 Revision 不是此智能体当前启用的版本。')
            return
          }
        }
        try {
          const artifact = await runtime.extensionService.buildRevision(revision)
          if (!artifact.clientEntry || artifact.buildKey !== match[4]) {
            throw new Error('Client buildKey 已过期或该 Revision 没有 Client Artifact。')
          }
          const source = await readFile(artifact.clientEntry, 'utf8')
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'client-artifact-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      if (action === 'call') {
        try {
          const parsed = HostApiContracts.extensionClientCall.parseRequest(await readJsonBody(req))
          const activation = runtime.repository.getActivation(parsed.agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) throw new Error('该 Revision 不是当前 Activation。')
          const value = await runtime.host.invokeExtensionActivation(
            parsed.agentId,
            revisionId,
            parsed.method,
            parsed.input,
          )
          writeJson(res, 200, HostApiContracts.extensionClientCall.parseResponse({ value }))
        } catch (error) {
          writeError(res, 400, 'extension-client-call-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (action === 'client-diagnostic') {
        try {
          const parsed = HostApiContracts.extensionClientDiagnostic.parseRequest(await readJsonBody(req))
          const activation = runtime.repository.getActivation(parsed.agentId, extensionId)
          if (activation?.extensionRevisionId !== revisionId) throw new Error('该 Revision 不是当前 Activation。')
          runtime.repository.upsertExtensionClientDiagnostic({
            agentId: parsed.agentId,
            extensionId,
            revisionId,
            status: parsed.status,
            ...(parsed.message === undefined ? {} : { message: parsed.message }),
            observedAt: Date.now(),
          })
          writeJson(res, 200, HostApiContracts.extensionClientDiagnostic.parseResponse({ accepted: true }))
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(
            res,
            400,
            'extension-client-diagnostic-failed',
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      if (action === 'host-client-diagnostic') {
        try {
          const parsed = HostApiContracts.hostExtensionClientDiagnostic.parseRequest(await readJsonBody(req))
          const installation = runtime.repository.getHostInstallation(extensionId)
          if (installation?.extensionRevisionId !== revisionId) {
            throw new Error('该 Revision 不是当前安装到本机的版本。')
          }
          runtime.recordHostClientDiagnostic(extensionId, {
            revisionId,
            status: parsed.status,
            ...(parsed.message === undefined ? {} : { message: parsed.message }),
          })
          writeContractJson(res, 200, HostApiContracts.hostExtensionClientDiagnostic, { accepted: true })
          broadcastExtensionsChanged()
        } catch (error) {
          writeError(res, 400, 'host-client-diagnostic-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
    },
  })
  return () => {
    pendingExtensionImports.clear()
    pendingHostUiCredentials.clear()
  }
}
