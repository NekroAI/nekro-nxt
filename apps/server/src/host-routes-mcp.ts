import { homedir } from 'node:os'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import { mcpExtensionSnapshot, testMcpServer } from './mcp-servers.js'

/** Verification evidence of a form-created MCP extension: there is no dynamic run, only the saved artifact check. */
const MCP_FORM_ORIGIN = {
  episodeId: 'mcp-form',
  pluginId: 'mcp-form',
  packageId: 'mcp-form',
  pluginRunId: 'local-form',
} as const

/** The administrator adds MCP servers in the Workshop; this is the only place a local `stdio` server is created. */
export function registerMcpRoutes({
  runtime,
  registerRoute,
  broadcast,
  broadcastExtensionsChanged,
}: HostRouteContext): () => void {
  // Connection outcomes arrive after the Session mounted; clients refresh the extension's usage rows.
  const unsubscribe = runtime.mcpStatus.subscribe(() =>
    broadcast({ event: 'snapshot-changed', data: { changed: true } }),
  )
  registerRoute({
    kind: 'exact',
    path: '/api/mcp-servers/test',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const input = HostApiContracts.testMcpServer.parseRequest(await readJsonBody(req))
        writeContractJson(res, 200, HostApiContracts.testMcpServer, await testMcpServer(input.server, homedir()))
      } catch (error) {
        writeError(res, 400, 'mcp-test-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/mcp-servers',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const input = HostApiContracts.createMcpExtension.parseRequest(await readJsonBody(req))
        const { snapshot, secretFields } = mcpExtensionSnapshot({
          displayName: input.displayName,
          description: input.description === '' ? `连接 MCP 服务 ${input.server.name}` : input.description,
          server: input.server,
        })
        const base = `mcp-${input.server.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-+|-+$/gu, '')}`
        let slug = base.length < 3 ? `${base}-server` : base
        for (let suffix = 2; runtime.repository.getExtensionBySlug(slug) !== undefined; suffix += 1) {
          slug = `${base}-${suffix}`
        }
        const saved = await runtime.extensionService.saveDynamicPackage({
          snapshot,
          slug,
          displayName: input.displayName,
          description: snapshot.purpose,
          verification: {
            dshVersion: DSH_RUNTIME_RELEASE.dshVersion,
            contractVersion: 'nekro-nxt-extension-v5',
            origin: MCP_FORM_ORIGIN,
            toolInvocations: [],
            rpcMethods: [],
            renderedPanels: [],
            renderedToolViews: [],
            renderedMessageRenderers: [],
            ...(snapshot.permissions === undefined ? {} : { permissions: snapshot.permissions }),
          },
        })
        broadcastExtensionsChanged()
        writeContractJson(res, 200, HostApiContracts.createMcpExtension, {
          extensionId: saved.extension.id,
          revisionId: saved.revision.id,
          secretFields: [...secretFields],
        })
      } catch (error) {
        writeError(res, 400, 'mcp-create-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return unsubscribe
}
