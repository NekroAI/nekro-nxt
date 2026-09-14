import { LlmProviderRemovalResultUnknown } from './host-model-settings.js'
import {
  DshNxtHostUiSchema,
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  HostApiContracts,
  HostUiPageInstanceIdSchema,
} from '@nekro-nxt/contracts'
import { hostUiPermissionDigest, scopeHostUiCss } from '@nekro-nxt/extension-runtime'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  createDshPluginExport,
  parseDshPluginTransfer,
  projectDshPlugins,
  readBinaryBody,
  readJsonBody,
  writeContractJson,
  writeDownload,
  writeError,
  writeJson,
  type HostRouteContext,
} from './host-route-support.js'
export function registerSettingsRoutes({
  runtime,
  registerRoute,
  broadcast,
  broadcastExtensionsChanged,
}: HostRouteContext): () => void {
  const dshPluginOperation = (
    operationId: string,
    kind: 'inspect' | 'install',
  ): {
    readonly progress: (
      phase: 'download' | 'dependencies' | 'build-scripts' | 'validation' | 'publish',
      message: string,
    ) => void
    readonly done: () => void
    readonly failed: (message: string) => void
  } => {
    let phase: 'download' | 'dependencies' | 'build-scripts' | 'validation' | 'publish' =
      kind === 'inspect' ? 'download' : 'publish'
    let message = kind === 'inspect' ? '正在检查 DSH 插件安装内容。' : '正在提交 DSH 插件安装。'
    const publish = (status: 'running' | 'done' | 'failed'): void =>
      broadcast({ event: 'dsh-plugin-operation', data: { operationId, kind, phase, status, message } })
    publish('running')
    return {
      progress: (nextPhase, nextMessage) => {
        phase = nextPhase
        message = nextMessage
        publish('running')
      },
      done: () => {
        message = kind === 'inspect' ? '安装内容检查完成。' : '插件已经安装并保持关闭。'
        publish('done')
      },
      failed: (failure) => {
        message = failure
        publish('failed')
      },
    }
  }
  registerRoute({
    kind: 'exact',
    path: '/api/client-notifications',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '客户端通知只支持 GET。')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawCursor = url.searchParams.get('cursor')
        const params = HostApiContracts.listClientNotifications.parseParams({
          ...(rawCursor === null ? {} : { cursor: Number(rawCursor) }),
        })
        writeContractJson(
          res,
          200,
          HostApiContracts.listClientNotifications,
          runtime.notifications.readClientNotifications(params.cursor),
        )
      } catch (error) {
        writeError(res, 400, 'client-notifications-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications',
    handler: async (req, res) => {
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', '通知设置只支持 PUT。')
        return
      }
      try {
        const parsed = HostApiContracts.updateNotificationSettings.parseRequest(await readJsonBody(req))
        const settings = await runtime.notifications.updateSettings({
          ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
          system: parsed.system,
          bark: {
            enabled: parsed.bark.enabled,
            serverUrl: parsed.bark.serverUrl,
            ...(parsed.bark.deviceKey === undefined ? {} : { deviceKey: parsed.bark.deviceKey }),
            ...(parsed.bark.clearDeviceKey === undefined ? {} : { clearDeviceKey: parsed.bark.clearDeviceKey }),
          },
          events: parsed.events,
        })
        writeContractJson(res, 200, HostApiContracts.updateNotificationSettings, settings)
      } catch (error) {
        writeError(res, 400, 'notification-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications/test',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Bark 通知测试只支持 POST。')
        return
      }
      try {
        const parsed = HostApiContracts.testBarkNotification.parseRequest(await readJsonBody(req))
        await runtime.notifications.testBark({
          serverUrl: parsed.serverUrl,
          ...(parsed.deviceKey === undefined ? {} : { deviceKey: parsed.deviceKey }),
        })
        writeContractJson(res, 200, HostApiContracts.testBarkNotification, { sent: true })
      } catch (error) {
        writeError(res, 400, 'notification-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/settings/notifications/test-system',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '系统通知测试只支持 POST。')
        return
      }
      try {
        HostApiContracts.testSystemNotification.parseRequest(undefined)
        runtime.notifications.publishSystemTest()
        writeContractJson(res, 200, HostApiContracts.testSystemNotification, { published: true })
      } catch (error) {
        writeError(res, 400, 'system-notification-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugins',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.dshPlugins.parseParams({})
        HostApiContracts.dshPlugins.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.dshPlugins, {
          plugins: projectDshPlugins(runtime),
        })
      } catch (error) {
        writeError(res, 500, 'dsh-plugins-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/settings',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.dshSettings.parseParams({})
        HostApiContracts.dshSettings.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.dshSettings, {
          namespaces: runtime.host.listDshSettings(),
        })
      } catch (error) {
        writeError(res, 500, 'dsh-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs/inspect',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const input = HostApiContracts.inspectDshPluginInstall.parseRequest(await readJsonBody(req))
        const operationId = input.operationId ?? randomUUID()
        const operation = dshPluginOperation(operationId, 'inspect')
        try {
          const inspection = await runtime.dshPluginInstaller.inspectRegistry(input.spec, operation.progress)
          operation.done()
          writeContractJson(res, 200, HostApiContracts.inspectDshPluginInstall, { ...inspection, operationId })
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-inspect-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs/inspect-tarball',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const requestedOperationId = req.headers['x-operation-id']
        const operationId =
          typeof requestedOperationId === 'string' && z.string().uuid().safeParse(requestedOperationId).success
            ? requestedOperationId
            : randomUUID()
        const operation = dshPluginOperation(operationId, 'inspect')
        const content = await readBinaryBody(req, 64 * 1024 * 1024)
        try {
          const isNxtArchive = content[0] === 0x50 && content[1] === 0x4b
          const imported = isNxtArchive ? parseDshPluginTransfer(content) : undefined
          const inspection = imported
            ? await runtime.dshPluginInstaller.inspectImportedTarball(
                imported.tarball,
                imported.expected,
                operation.progress,
              )
            : await runtime.dshPluginInstaller.inspectTarball(content, operation.progress)
          operation.done()
          writeJson(res, 200, HostApiContracts.inspectDshPluginInstall.parseResponse({ ...inspection, operationId }))
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-inspect-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/plugin-installs',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const input = HostApiContracts.commitDshPluginInstall.parseRequest(await readJsonBody(req))
        const operationId = input.operationId ?? randomUUID()
        const operation = dshPluginOperation(operationId, 'install')
        try {
          const installed = await runtime.dshPluginInstaller.commit(
            input.token,
            input.approvedBuilds,
            operation.progress,
          )
          operation.done()
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          writeContractJson(res, 200, HostApiContracts.commitDshPluginInstall, {
            packageId: installed.id,
            operationId,
          })
        } catch (error) {
          operation.failed(error instanceof Error ? error.message : String(error))
          throw error
        }
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-install-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/plugin-entries',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const hostUiClientMatch =
        /^\/api\/dsh\/plugin-entries\/([^/]+)\/host-ui\/client\/([a-f0-9]{64})\.(mjs|css)$/u.exec(url.pathname)
      if (hostUiClientMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'DSH 页面 Client 只支持 GET。')
          return
        }
        try {
          const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(hostUiClientMatch[1] ?? ''))
          const activation = runtime.repository
            .listDshPluginActivations(entryId)
            .find((candidate) => candidate.target === 'host')
          if (!activation) throw new Error('对应 DSH Host 入口未启用。')
          const client = await runtime.dshPluginInstaller.readHostUiClient(entryId)
          if (client.packageDigest !== hostUiClientMatch[2]) throw new Error('DSH 页面 Client 摘要已过期。')
          const css = hostUiClientMatch[3] === 'css'
          res.writeHead(200, {
            'content-type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'cache-control': 'private, no-cache',
          })
          res.end(css ? scopeHostUiCss(client.css ?? '', client.packageDigest) : client.source)
        } catch (error) {
          writeError(res, 409, 'dsh-host-ui-client-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const hostUiAssetMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/host-ui\/assets\/([a-f0-9]{64})\.svg$/u.exec(
        url.pathname,
      )
      if (hostUiAssetMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'DSH 页面图标只支持 GET。')
          return
        }
        try {
          const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(hostUiAssetMatch[1] ?? ''))
          const activation = runtime.repository
            .listDshPluginActivations(entryId)
            .find((candidate) => candidate.target === 'host')
          if (!activation) throw new Error('对应 DSH Host 入口未启用。')
          const source = await runtime.dshPluginInstaller.readHostUiSvg(entryId, hostUiAssetMatch[2] ?? '')
          res.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(source)
        } catch (error) {
          writeError(res, 409, 'dsh-host-ui-icon-unavailable', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const activationMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/activation$/u.exec(url.pathname)
      const configMatch = /^\/api\/dsh\/plugin-entries\/([^/]+)\/config\/inspect$/u.exec(url.pathname)
      const encodedEntryId = activationMatch?.[1] ?? configMatch?.[1]
      if (!encodedEntryId) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      try {
        const entryId = DshPluginEntryIdSchema.parse(decodeURIComponent(encodedEntryId))
        if (configMatch) {
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-not-allowed', '检查 DSH 插件配置只支持 POST。')
            return
          }
          HostApiContracts.inspectDshPluginEntryConfig.parseRequest(undefined)
          writeContractJson(
            res,
            200,
            HostApiContracts.inspectDshPluginEntryConfig,
            await runtime.host.inspectInstalledDshPluginConfig(entryId),
          )
          return
        }
        if (req.method === 'PUT') {
          const input = HostApiContracts.activateDshPluginEntry.parseRequest(await readJsonBody(req))
          const entry = runtime.repository.getDshPluginEntry(entryId)
          const packageRecord = entry ? runtime.repository.getDshPluginPackage(entry.packageId) : undefined
          const manifest = packageRecord?.manifest
          const nekroNxt =
            typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
              ? manifest['nekroNxt']
              : undefined
          const metadata = DshNxtHostUiSchema.safeParse(
            typeof nekroNxt === 'object' && nekroNxt !== null && !Array.isArray(nekroNxt)
              ? nekroNxt['hostUi']
              : undefined,
          )
          const permissionDigest = metadata.success ? hostUiPermissionDigest(metadata.data.permissions) : undefined
          if (metadata.success && metadata.data.entryKey === entry?.entryKey && input.target === 'host') {
            const grant = runtime.repository.getHostUiPermissionGrant(`dsh:${entryId}`)
            const approved =
              grant?.artifactDigest === packageRecord?.packageDigest && grant?.permissionDigest === permissionDigest
            if (!approved && input.permissionApproval?.permissionDigest !== permissionDigest) {
              throw new Error(`permission-approval-required:${permissionDigest}`)
            }
          }
          const activation = await runtime.host.activateInstalledDshPlugin({
            entryId,
            target: input.target,
            config: input.config,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            ...(input.target === 'host' &&
            metadata.success &&
            metadata.data.entryKey === entry?.entryKey &&
            packageRecord &&
            permissionDigest
              ? {
                  hostUi: {
                    grant: {
                      ownerKey: `dsh:${entryId}`,
                      artifactDigest: packageRecord.packageDigest,
                      permissionDigest,
                      declaration: metadata.data.permissions,
                      approvedAt: Date.now(),
                    },
                    artifactDigest: packageRecord.packageDigest,
                    pages: metadata.data.pages,
                    clientBuildKey: packageRecord.packageDigest,
                    now: Date.now(),
                    nextPageInstanceId: () =>
                      HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
                  },
                }
              : {}),
          })
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.activateDshPluginEntry, {
            targetKey: activation.targetKey,
          })
          return
        }
        if (req.method === 'DELETE') {
          const input = HostApiContracts.deactivateDshPluginEntry.parseRequest(await readJsonBody(req))
          await runtime.host.disableInstalledDshPlugin(entryId, input.targetKey)
          broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
          broadcastExtensionsChanged()
          writeContractJson(res, 200, HostApiContracts.deactivateDshPluginEntry, { disabled: true })
          return
        }
        writeError(res, 405, 'method-not-allowed', '只支持 PUT 或 DELETE。')
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-activation-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/plugin-installs',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const exportMatch = /^\/api\/dsh\/plugin-installs\/([^/]+)\/export$/u.exec(url.pathname)
      if (exportMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '导出 DSH 插件只支持 GET。')
          return
        }
        try {
          const packageId = DshPluginPackageIdSchema.parse(decodeURIComponent(exportMatch[1] ?? ''))
          const exported = await createDshPluginExport(runtime, packageId)
          writeDownload(res, exported.filename, exported.body)
        } catch (error) {
          writeError(res, 400, 'dsh-plugin-export-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/dsh\/plugin-installs\/([^/]+)$/u.exec(url.pathname)
      if (!match?.[1]) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', '只支持 DELETE。')
        return
      }
      try {
        const packageId = DshPluginPackageIdSchema.parse(decodeURIComponent(match[1]))
        HostApiContracts.removeDshPluginPackage.parseRequest(undefined)
        await runtime.removeDshPluginPackage(packageId)
        broadcast({ event: 'dsh-plugins-changed', data: { changed: true } })
        writeContractJson(res, 200, HostApiContracts.removeDshPluginPackage, { removed: true })
      } catch (error) {
        writeError(res, 400, 'dsh-plugin-remove-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/settings',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/dsh\/settings\/([^/]+)\/mutate$/u.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        const encodedNamespace = match[1]
        if (encodedNamespace === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const params = HostApiContracts.dshSettingsMutate.parseParams({
          namespace: decodeURIComponent(encodedNamespace),
        })
        const input = HostApiContracts.dshSettingsMutate.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.dshSettingsMutate,
          await runtime.host.mutateDshSettings(params.namespace, input.expectedRevision, input.ops),
        )
      } catch (error) {
        const conflict = error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT'
        writeError(
          res,
          conflict ? 409 : 400,
          conflict ? 'dsh-settings-conflict' : 'dsh-settings-rejected',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/dsh/credentials/describe',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.dshCredentialsDescribe.parseParams({})
        const input = HostApiContracts.dshCredentialsDescribe.parseRequest(await readJsonBody(req))
        writeContractJson(res, 200, HostApiContracts.dshCredentialsDescribe, {
          credentials: await runtime.host.describeDshCredentials(input.refs),
        })
      } catch (error) {
        writeError(res, 400, 'dsh-credentials-rejected', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/dsh/credentials',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/dsh\/credentials\/([^/]+)$/u.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      try {
        const encodedRef = match[1]
        if (encodedRef === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        const ref = decodeURIComponent(encodedRef)
        if (req.method === 'PUT') {
          const params = HostApiContracts.dshCredentialSet.parseParams({ ref })
          const input = HostApiContracts.dshCredentialSet.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.dshCredentialSet,
            await runtime.host.setDshCredential(params.ref, input.value),
          )
          return
        }
        if (req.method === 'DELETE') {
          const params = HostApiContracts.dshCredentialUnset.parseParams({ ref })
          HostApiContracts.dshCredentialUnset.parseRequest(undefined)
          writeContractJson(
            res,
            200,
            HostApiContracts.dshCredentialUnset,
            await runtime.host.unsetDshCredential(params.ref),
          )
          return
        }
        writeError(res, 405, 'method-not-allowed', '只支持 PUT/DELETE。')
      } catch (error) {
        writeError(res, 400, 'dsh-credentials-rejected', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/llm/providers',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '只支持 GET。')
        return
      }
      try {
        HostApiContracts.llmProviders.parseParams({})
        HostApiContracts.llmProviders.parseRequest(undefined)
        writeContractJson(res, 200, HostApiContracts.llmProviders, await runtime.host.getLlmProviderSettings())
      } catch (error) {
        writeError(res, 500, 'llm-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/llm/discover-models',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.llmDiscoverModels.parseParams({})
        const parsed = HostApiContracts.llmDiscoverModels.parseRequest(await readJsonBody(req))
        writeContractJson(res, 200, HostApiContracts.llmDiscoverModels, {
          models: await runtime.host.discoverLlmProviderModels({
            ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
            ...(parsed.settingsNs === undefined ? {} : { settingsNs: parsed.settingsNs }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
          }),
        })
      } catch (error) {
        writeError(res, 400, 'model-discovery-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/llm/test-provider',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      try {
        HostApiContracts.llmTestProvider.parseParams({})
        const parsed = HostApiContracts.llmTestProvider.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.llmTestProvider,
          await runtime.host.testLlmProvider({
            provider: parsed.provider,
            model: parsed.model,
            ...(parsed.settingsNs === undefined ? {} : { settingsNs: parsed.settingsNs }),
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.models === undefined
              ? {}
              : {
                  models: parsed.models.map((entry) => ({
                    id: entry.id,
                    ...(entry.name === undefined ? {} : { name: entry.name }),
                    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
                    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
                  })),
                }),
          }),
        )
      } catch (error) {
        writeError(res, 400, 'llm-provider-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/llm/providers',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/llm\/providers\/([^/]+)(\/removal-impact)?$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (match[2] ? req.method !== 'GET' : req.method !== 'POST' && req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', match[2] ? '只支持 GET。' : '只支持 POST/DELETE。')
        return
      }
      try {
        const encodedProvider = match[1]
        if (encodedProvider === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        if (match[2]) {
          const params = HostApiContracts.llmProviderRemovalImpact.parseParams({
            provider: decodeURIComponent(encodedProvider),
          })
          writeContractJson(
            res,
            200,
            HostApiContracts.llmProviderRemovalImpact,
            await runtime.host.getLlmProviderRemovalImpact(params.provider),
          )
          return
        }
        if (req.method === 'DELETE') {
          const params = HostApiContracts.llmRemoveProvider.parseParams({
            provider: decodeURIComponent(encodedProvider),
          })
          const input = HostApiContracts.llmRemoveProvider.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.llmRemoveProvider,
            await runtime.host.removeLlmProvider(params.provider, input.expectedRevision),
          )
          return
        }
        const params = HostApiContracts.llmSaveProvider.parseParams({ provider: decodeURIComponent(encodedProvider) })
        const parsed = HostApiContracts.llmSaveProvider.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.llmSaveProvider,
          await runtime.host.saveLlmProvider({
            provider: params.provider,
            expectedRevision: parsed.expectedRevision,
            ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
            ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
            ...(parsed.baseURL === undefined ? {} : { baseURL: parsed.baseURL }),
            ...(parsed.api === undefined ? {} : { api: parsed.api }),
            ...(parsed.models === undefined
              ? {}
              : {
                  models: parsed.models.map((model) => ({
                    id: model.id,
                    ...(model.name === undefined ? {} : { name: model.name }),
                    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
                    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
                  })),
                }),
          }),
        )
      } catch (error) {
        const code =
          error instanceof LlmProviderRemovalResultUnknown
            ? 503
            : error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT'
              ? 409
              : 400
        writeError(res, code, 'llm-provider-mutation-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return () => undefined
}
