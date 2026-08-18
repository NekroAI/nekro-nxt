/**
 * NekroNxt Server executable entry — assembles the domain runtime (NekroRuntime),
 * mounts the DSH WebServer seam as the single HTTP/SSE host, and serves the Web
 * product dist through the frontend-static fallback. Design: docs/08.
 *
 * Data and dist roots are explicit — never inferred from the current directory
 * silently (docs/06): resolveRoot returns absolute paths under cwd unless the
 * caller supplies absolute inputs.
 */
import { Context } from '@deepseek-ai/cordis'
import {
  apply as frontendStaticApply,
  inject as frontendStaticInject,
  name as frontendStaticName,
} from '@deepseek-ai/dsh-host-frontend-static'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { Context as LlmContext } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NekroRuntime } from './bootstrap.js'
import { createNekroHostApi } from './host-api.js'

const resolveRoot = (input: string): string => (path.isAbsolute(input) ? input : path.resolve(process.cwd(), input))

const PROVIDER_ROUTE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** Parse the Host-owned provider route allowlist; DSH still owns each route's catalog and protocol. */
export const parseLlmProviderRoutes = (input: string | undefined): readonly string[] => {
  if (input === undefined || input.trim() === '') return []
  const routes = [
    ...new Set(
      input
        .split(',')
        .map((route) => route.trim())
        .filter(Boolean),
    ),
  ]
  const invalid = routes.find((route) => !PROVIDER_ROUTE_PATTERN.test(route))
  if (invalid) throw new TypeError(`NEKRO_LLM_PROVIDERS 包含无效路由：${invalid}`)
  return routes
}

/** Mount DSH's generic provider plugin; NekroNxt does not copy provider endpoints or model catalogs. */
export const configureDshLlmProviders =
  (routes: readonly string[]): NonNullable<StartServerOptions['configureLlm']> =>
  async (context) => {
    const providers: Record<string, LlmPiAi.PiAiProviderProfile> = Object.fromEntries(
      routes.map((route) => [route, {}]),
    )
    await context.plugin(LlmPiAi, { providers })
  }

export const defaultWebDistIndex = (): string => fileURLToPath(new URL('../../web/dist/index.html', import.meta.url))

export interface StartServerOptions {
  /** Root of the durable data directory (core.sqlite / sessions.sqlite / assets / extension-*). */
  readonly dataRoot: string
  /**
   * Optional Host workspace root override. Defaults to `<dataRoot>/workspaces`;
   * each intelligent-agent still receives its own `<agentId>` child directory.
   */
  readonly developmentWorkspaceRoot?: string
  /** Absolute path to the built Web `dist/index.html`. */
  readonly distIndex: string
  readonly host?: '127.0.0.1' | '0.0.0.0'
  readonly port?: number
  /** Optional real LLM adapter wiring for a non-test server. */
  readonly configureLlm?: (context: LlmContext) => Promise<void> | void
}

export interface NekroServerHandle {
  readonly port: number
  stop(): Promise<void>
}

export const startNekroServer = async (options: StartServerOptions): Promise<NekroServerHandle> => {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const dataRoot = resolveRoot(options.dataRoot)
  const developmentWorkspaceRoot = resolveRoot(options.developmentWorkspaceRoot ?? path.join(dataRoot, 'workspaces'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(developmentWorkspaceRoot, { recursive: true, mode: 0o700 })

  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(dataRoot, 'core.sqlite'),
    sessionDatabasePath: path.join(dataRoot, 'sessions.sqlite'),
    assetRoot: path.join(dataRoot, 'assets'),
    extensionDataRoot: path.join(dataRoot, 'extension-data'),
    extensionCacheRoot: path.join(dataRoot, 'extension-cache'),
    credentialRoot: path.join(dataRoot, 'credentials'),
    llmSettingsPath: path.join(dataRoot, 'dsh', 'settings.yaml'),
    llmCredentialPath: path.join(dataRoot, 'dsh', '.credentials.yaml'),
    developmentWorkspaceRoot,
    ...(options.configureLlm === undefined ? {} : { configureLlm: options.configureLlm }),
  })
  await runtime.start()
  await runtime.recover()

  // The HTTP/SSE host owns a narrow Cordis Context with the WebServer seam and
  // the static dist fallback. The DSH Session runtime stays inside NekroRuntime.
  const webContext = new Context()
  await webContext.plugin(WebServer, { host, port })
  // Function-style Cordis plugin that claims the webserver fallback seat and
  // serves the built dist with SPA fallback to index.html.
  await webContext.plugin(
    { name: frontendStaticName, inject: frontendStaticInject, apply: frontendStaticApply },
    { distIndex: resolveRoot(options.distIndex) },
  )
  const api = createNekroHostApi(webContext.webServer, runtime)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    api.dispose()
    await webContext.fiber.dispose()
    await runtime.dispose()
  }

  return { port: webContext.webServer.port, stop }
}

const isEntryPoint = (): boolean => {
  if (process.argv[1] === undefined) return false
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  } catch {
    return false
  }
}

// Only auto-start when invoked as an entry point (pnpm dev/start), not on import.
if (isEntryPoint()) {
  void (async () => {
    const dataRoot = process.env.NEKRO_DATA ?? 'data'
    const developmentWorkspaceRoot = process.env.NEKRO_DEVELOPMENT_WORKSPACE_ROOT
    const distIndexEnv = process.env.NEKRO_DIST_INDEX
    const portEnv = process.env.NEKRO_PORT
    const llmProviderRoutes = parseLlmProviderRoutes(process.env.NEKRO_LLM_PROVIDERS)
    const port = portEnv !== undefined && portEnv.trim() !== '' ? Number(portEnv) : 4960
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`[nekro-nxt] NEKRO_PORT 无效：${portEnv}`)
      process.exit(1)
    }
    try {
      const distIndex = distIndexEnv ? resolveRoot(distIndexEnv) : defaultWebDistIndex()
      if (!existsSync(distIndex)) {
        throw new Error(
          `Web dist/index.html 不存在：${distIndex}。请先运行 ` + '`pnpm --filter @nekro-nxt/web build`。',
        )
      }
      const handle = await startNekroServer({
        dataRoot,
        distIndex,
        port,
        ...(developmentWorkspaceRoot === undefined || developmentWorkspaceRoot.trim() === ''
          ? {}
          : { developmentWorkspaceRoot }),
        configureLlm: configureDshLlmProviders(llmProviderRoutes),
      })
      console.log(`[nekro-nxt] Server 已监听 http://127.0.0.1:${handle.port}`)
      if (llmProviderRoutes.length > 0) {
        console.log(`[nekro-nxt] DSH 模型供应商已启用：${llmProviderRoutes.join(', ')}`)
      }
      const onSignal = (signal: NodeJS.Signals): void => {
        console.log(`[nekro-nxt] 收到 ${signal}，正在关闭。`)
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
        void handle.stop().then(() => process.exit(0))
      }
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
    } catch (error) {
      console.error('[nekro-nxt] 启动失败：', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })()
}
