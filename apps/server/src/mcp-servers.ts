import type { Context } from '@deepseek-ai/cordis'
import * as McpClientPlugin from '@deepseek-ai/dsh-mcp-client'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  type ExtensionMcpCapability,
  type ExtensionMcpServer,
  type ExtensionMcpValue,
  type ConfigSchemaNode,
  type McpServerForm,
} from '@nekro-nxt/contracts'
import type { DynamicPackageSnapshot } from '@nekro-nxt/extension-runtime'

const TOOL_CALL_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 20_000
const TEST_MAX_TOOLS = 100

/** Host code of a form-created MCP extension: the Host connects the declared servers, the extension runs nothing. */
export const MCP_EXTENSION_HOST_CODE = `return {
  apply() {
    // MCP 服务由宿主按 permissions.capabilities.mcp 连接；这个扩展本身不运行代码。
  },
}
`

const rowsOf = (form: McpServerForm) => (form.transport === 'stdio' ? form.env : form.headers)

const secretKey = (form: McpServerForm, index: number): string =>
  `${form.transport === 'stdio' ? 'env' : 'header'}_${index + 1}`

/**
 * Package snapshot of an MCP extension built from the form. Secret rows are declared as credential fields and only
 * referenced from the capability, so no credential is written into the Revision; the client stores the typed values as
 * an Activation's credentials.
 */
export const mcpExtensionSnapshot = (input: {
  readonly displayName: string
  readonly description: string
  readonly server: McpServerForm
}): {
  readonly snapshot: DynamicPackageSnapshot
  readonly secretFields: readonly { readonly key: string; readonly name: string }[]
} => {
  const { server } = input
  const values: Record<string, ExtensionMcpValue> = {}
  const dict: Record<string, ConfigSchemaNode> = {}
  const secretFields: { key: string; name: string }[] = []
  rowsOf(server).forEach((row, index) => {
    if (!row.secret) {
      values[row.name] = row.value
      return
    }
    const key = secretKey(server, index)
    values[row.name] = { secret: key }
    dict[key] = {
      type: 'string',
      meta: {
        description: server.transport === 'stdio' ? `环境变量 ${row.name}` : `请求头 ${row.name}`,
        role: 'secret',
        required: true,
      },
    }
    secretFields.push({ key, name: row.name })
  })
  const declared: ExtensionMcpServer =
    server.transport === 'stdio'
      ? { transport: 'stdio', name: server.name, command: server.command, args: server.args, env: values }
      : { transport: 'streamable-http', name: server.name, url: server.url, headers: values }
  const mcp: ExtensionMcpCapability = { servers: [declared] }
  return {
    snapshot: {
      name: input.displayName,
      purpose: input.description,
      hostCode: MCP_EXTENSION_HOST_CODE,
      permissions: { permissions: [], networkOrigins: [], capabilities: { mcp } },
      contributions: [],
      ...(Object.keys(dict).length === 0 ? {} : { config: { schema: { type: 'object', dict } } }),
    },
    secretFields,
  }
}

const resolveValues = async (
  values: Readonly<Record<string, ExtensionMcpValue>>,
  readSecret: (key: string) => Promise<string | undefined>,
): Promise<{ readonly values: Record<string, string>; readonly missing: readonly string[] }> => {
  const resolved: Record<string, string> = {}
  const missing: string[] = []
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      resolved[name] = value
      continue
    }
    const secret = await readSecret(value.secret)
    if (secret === undefined || secret === '') missing.push(name)
    else resolved[name] = secret
  }
  return { values: resolved, missing }
}

export type McpPluginConfig = McpClientPlugin.Config

/** DSH bridge configuration with credentials filled in; a server missing a credential is reported, not connected. */
export const mcpPluginConfig = async (
  server: ExtensionMcpServer,
  options: { readonly readSecret: (key: string) => Promise<string | undefined>; readonly cwd: string },
): Promise<{ readonly config: McpPluginConfig } | { readonly missing: readonly string[] }> => {
  if (server.transport === 'stdio') {
    const env = await resolveValues(server.env, options.readSecret)
    if (env.missing.length > 0) return { missing: env.missing }
    return {
      config: {
        transport: 'stdio',
        serverName: server.name,
        command: server.command,
        args: [...server.args],
        env: env.values,
        cwd: options.cwd,
        toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
        failOnStartupError: false,
      },
    }
  }
  const headers = await resolveValues(server.headers, options.readSecret)
  if (headers.missing.length > 0) return { missing: headers.missing }
  return {
    config: {
      transport: 'streamable-http',
      serverName: server.name,
      url: server.url,
      headers: headers.values,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    },
  }
}

/**
 * Starts the DSH MCP bridge for each server inside an Activation's Session context, without waiting for the
 * connection: a slow or unreachable server must not hold the agent's turn. The bridge reconnects on its own and its
 * tools disappear with the context.
 */
export const mountMcpServers = (
  context: Context,
  configs: readonly McpPluginConfig[],
  report: (serverName: string, outcome: { readonly toolCount: number } | { readonly error: unknown }) => void,
): void => {
  for (const config of configs) {
    const prefix = `mcp__${config.serverName}__`
    void Promise.resolve(context.plugin(McpClientPlugin, config)).then(
      () =>
        report(config.serverName, {
          toolCount: context.tools.schemas(scopeOf(context)).filter(({ name }) => name.startsWith(prefix)).length,
        }),
      (error: unknown) => report(config.serverName, { error }),
    )
  }
}

const AMBIENT_SECRET = /KEY|PASSWORD|SECRET|TOKEN/iu

export interface McpTestResult {
  readonly ok: boolean
  readonly message: string
  readonly serverName?: string
  readonly tools: readonly { readonly name: string; readonly description?: string }[]
}

/** Connects once with the typed values, lists tools and disconnects; used by the form before saving. */
export const testMcpServer = async (form: McpServerForm, cwd: string): Promise<McpTestResult> => {
  const values = Object.fromEntries(rowsOf(form).map((row) => [row.name, row.value]))
  const client = new Client({ name: 'nekro-nxt', version: '1.0.0' })
  const transport =
    form.transport === 'stdio'
      ? new StdioClientTransport({
          command: form.command,
          args: [...form.args],
          env: {
            ...Object.fromEntries(
              Object.entries(getDefaultEnvironment()).filter(([name]) => !AMBIENT_SECRET.test(name)),
            ),
            ...values,
          },
          cwd,
          stderr: 'ignore',
        })
      : new StreamableHTTPClientTransport(new URL(form.url), { requestInit: { headers: values } })
  const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS)
  try {
    await client.connect(transport, { signal: timeout, timeout: TEST_TIMEOUT_MS })
    const listed = await client.listTools(undefined, { signal: timeout, timeout: TEST_TIMEOUT_MS })
    const tools = listed.tools.slice(0, TEST_MAX_TOOLS).map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description.slice(0, 300) }),
    }))
    const serverName = client.getServerVersion()?.name
    return {
      ok: true,
      message: tools.length === 0 ? '已连接，但这个服务没有提供工具。' : `已连接，提供 ${listed.tools.length} 个工具。`,
      ...(serverName === undefined ? {} : { serverName }),
      tools,
    }
  } catch (error) {
    const message = timeout.aborted ? '连接超时。' : error instanceof Error ? error.message : String(error)
    return { ok: false, message: `连接失败：${message}`, tools: [] }
  } finally {
    await client.close().catch(() => undefined)
  }
}

export interface McpServerStatus {
  readonly name: string
  readonly state: 'connecting' | 'connected' | 'unavailable' | 'missing-credentials'
  readonly toolCount?: number
  readonly missing?: readonly string[]
  readonly message?: string
  readonly observedAt: number
}

/**
 * Latest connection attempt per (agent, extension, server), for the extension's usage rows. Each Session connects
 * separately, so the newest attempt of any Session wins; the DSH bridge's later reconnects are not tracked here.
 */
export class McpStatusRegistry {
  readonly #statuses = new Map<string, Map<string, McpServerStatus>>()
  readonly #listeners = new Set<() => void>()

  set(agentId: string, extensionId: string, status: McpServerStatus): void {
    const key = `${agentId}\0${extensionId}`
    const servers = this.#statuses.get(key) ?? new Map<string, McpServerStatus>()
    servers.set(status.name, status)
    this.#statuses.set(key, servers)
    for (const listener of this.#listeners) listener()
  }

  list(agentId: string, extensionId: string): readonly McpServerStatus[] {
    return [...(this.#statuses.get(`${agentId}\0${extensionId}`)?.values() ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
