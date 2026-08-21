/**
 * NekroNxt Server executable entry — assembles the domain runtime (NekroRuntime),
 * mounts the DSH WebServer seam as the single HTTP/SSE host, and serves the Web
 * product dist through the frontend-static fallback plus explicit product SPA
 * routes. Design: docs/08.
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
import { createSqliteBackupSet, type SqliteBackupSource } from '@nekro-nxt/storage-sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NekroRuntime } from './bootstrap.js'
import { createNekroHostApi } from './host-api.js'

const resolveRoot = (input: string): string => (path.isAbsolute(input) ? input : path.resolve(process.cwd(), input))

const PROVIDER_ROUTE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const SERVER_PACKAGE_NAME = '@nekro-nxt/server'
const SERVER_PACKAGE_VERSION = '0.0.0'

export const defaultReleaseId = (): string => `${SERVER_PACKAGE_NAME}@${SERVER_PACKAGE_VERSION}`

export const parseReleaseId = (input: string | undefined): string => {
  if (input === undefined) return defaultReleaseId()
  const releaseId = input.trim()
  if (releaseId.length === 0 || releaseId.length > 256) {
    throw new TypeError('NEKRO_RELEASE_ID 必须是 1 至 256 个字符。')
  }
  return releaseId
}

export const parseListenHost = (input: string | undefined): '127.0.0.1' | '0.0.0.0' => {
  if (input === undefined || input.trim() === '') return '127.0.0.1'
  if (input === '127.0.0.1' || input === '0.0.0.0') return input
  throw new TypeError(`NEKRO_HOST 无效：${input}`)
}

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
export const defaultDataRoot = (): string => fileURLToPath(new URL('../../../data', import.meta.url))

/** Product-owned client routes. DSH's rc.1 static fallback intentionally returns 404 for unknown paths. */
export const NEKRO_SPA_ROUTE_PREFIXES = [
  '/work',
  '/agents',
  '/channels',
  '/creator',
  '/runtime',
  '/settings',
  '/connections',
  '/extensions',
] as const

/** Register the product SPA surface without turning missing assets or API paths into index responses. */
export const registerNekroSpaRoutes = (webServer: WebServer, distIndex: string): (() => void) => {
  const resolvedDistIndex = resolveRoot(distIndex)
  const disposers: Array<() => void> = []
  const renderIndex = async (): Promise<string> => webServer.renderIndex(await readFile(resolvedDistIndex, 'utf8'))
  try {
    for (const routePath of NEKRO_SPA_ROUTE_PREFIXES) {
      disposers.push(
        webServer.register({
          kind: 'prefix',
          path: routePath,
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' })
              res.end()
              return
            }
            const html = await renderIndex()
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-cache',
            })
            res.end(req.method === 'HEAD' ? undefined : html)
          },
        }),
      )
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export interface ReleaseSqliteBackupRecord {
  readonly format: 'nxt.server-release-sqlite-backup'
  readonly version: 1
  readonly releaseId: string
  readonly backupId: string
  readonly databases: readonly string[]
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const parseReleaseBackupRecord = (input: unknown, expectedReleaseId: string): ReleaseSqliteBackupRecord => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('format' in input) ||
    input.format !== 'nxt.server-release-sqlite-backup' ||
    !('version' in input) ||
    input.version !== 1 ||
    !('releaseId' in input) ||
    input.releaseId !== expectedReleaseId ||
    !('backupId' in input) ||
    typeof input.backupId !== 'string' ||
    !('databases' in input) ||
    !Array.isArray(input.databases) ||
    !input.databases.every((name) => typeof name === 'string')
  ) {
    throw new Error(`Release SQLite 备份记录无效：${expectedReleaseId}`)
  }
  return {
    format: input.format,
    version: input.version,
    releaseId: input.releaseId,
    backupId: input.backupId,
    databases: input.databases,
  }
}

const existingSqliteSources = async (dataRoot: string): Promise<readonly SqliteBackupSource[]> => {
  const candidates: readonly SqliteBackupSource[] = [
    { name: 'core', filename: path.join(dataRoot, 'core.sqlite') },
    { name: 'sessions', filename: path.join(dataRoot, 'sessions.sqlite') },
  ]
  const sources: SqliteBackupSource[] = []
  for (const candidate of candidates) {
    try {
      const entry = await stat(candidate.filename)
      if (!entry.isFile()) throw new Error(`SQLite 路径不是普通文件：${candidate.filename}`)
      sources.push(candidate)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return sources
}

/**
 * Create the release-scoped pre-migration backup for the two SQLite lanes.
 * Other durable data-root entries intentionally remain outside this experiment.
 */
export const ensureReleaseSqliteBackup = async (
  dataRootInput: string,
  releaseIdInput: string,
): Promise<ReleaseSqliteBackupRecord> => {
  const dataRoot = resolveRoot(dataRootInput)
  const releaseId = parseReleaseId(releaseIdInput)
  const backupId = `release-${createHash('sha256').update(releaseId).digest('hex')}`
  const backupRoot = path.join(dataRoot, 'backups')
  const destination = path.join(backupRoot, backupId)
  const releaseRecordPath = path.join(destination, 'release.json')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })

  try {
    return parseReleaseBackupRecord(JSON.parse(await readFile(releaseRecordPath, 'utf8')), releaseId)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const sources = await existingSqliteSources(dataRoot)
  if (sources.length === 0) {
    await mkdir(destination, { mode: 0o700 })
  } else {
    await createSqliteBackupSet(sources, destination)
  }
  const record: ReleaseSqliteBackupRecord = {
    format: 'nxt.server-release-sqlite-backup',
    version: 1,
    releaseId,
    backupId,
    databases: sources.map((source) => source.name),
  }
  await writeFile(releaseRecordPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  return record
}

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
  /** Non-secret immutable image/application release identity exposed by readiness. */
  readonly releaseId?: string
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
  const releaseId = parseReleaseId(options.releaseId)
  const dataRoot = resolveRoot(options.dataRoot)
  const developmentWorkspaceRoot = resolveRoot(options.developmentWorkspaceRoot ?? path.join(dataRoot, 'workspaces'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(developmentWorkspaceRoot, { recursive: true, mode: 0o700 })
  await ensureReleaseSqliteBackup(dataRoot, releaseId)

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
  // serves real dist files. Since DSH rc.1 intentionally 404s unknown paths,
  // NekroNxt separately owns its known SPA route prefixes.
  const distIndex = resolveRoot(options.distIndex)
  await webContext.plugin(
    { name: frontendStaticName, inject: frontendStaticInject, apply: frontendStaticApply },
    { distIndex },
  )
  const disposeSpaRoutes = registerNekroSpaRoutes(webContext.webServer, distIndex)
  const api = createNekroHostApi(webContext.webServer, runtime)
  const registerHealthRoute = (routePath: '/health/live' | '/health/ready', status: 'live' | 'ready'): (() => void) =>
    webContext.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
          response.end()
          return
        }
        const body = JSON.stringify({ status, releaseId })
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      },
    })
  const disposeLive = registerHealthRoute('/health/live', 'live')
  const disposeReady = registerHealthRoute('/health/ready', 'ready')

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    disposeReady()
    disposeLive()
    api.dispose()
    disposeSpaRoutes()
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
    try {
      const dataRoot = process.env['NEKRO_DATA'] ?? defaultDataRoot()
      const developmentWorkspaceRoot = process.env['NEKRO_DEVELOPMENT_WORKSPACE_ROOT']
      const distIndexEnv = process.env['NEKRO_DIST_INDEX']
      const portEnv = process.env['NEKRO_PORT']
      const host = parseListenHost(process.env['NEKRO_HOST'])
      const releaseId = parseReleaseId(process.env['NEKRO_RELEASE_ID'])
      const llmProviderRoutes = parseLlmProviderRoutes(process.env['NEKRO_LLM_PROVIDERS'])
      const port = portEnv !== undefined && portEnv.trim() !== '' ? Number(portEnv) : 4960
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new TypeError(`NEKRO_PORT 无效：${portEnv}`)
      }
      const distIndex = distIndexEnv ? resolveRoot(distIndexEnv) : defaultWebDistIndex()
      if (!existsSync(distIndex)) {
        throw new Error(
          `Web dist/index.html 不存在：${distIndex}。请先运行 ` + '`pnpm --filter @nekro-nxt/web build`。',
        )
      }
      const handle = await startNekroServer({
        dataRoot,
        distIndex,
        host,
        port,
        releaseId,
        ...(developmentWorkspaceRoot === undefined || developmentWorkspaceRoot.trim() === ''
          ? {}
          : { developmentWorkspaceRoot }),
        configureLlm: configureDshLlmProviders(llmProviderRoutes),
      })
      console.log(`[nekro-nxt] Server ${releaseId} 已监听 http://${host}:${handle.port}`)
      if (llmProviderRoutes.length > 0) {
        console.log(`[nekro-nxt] DSH 模型供应商已启用：${llmProviderRoutes.join(', ')}`)
      }
      const onSignal = (signal: NodeJS.Signals): void => {
        console.log(`[nekro-nxt] 收到 ${signal}，正在关闭。`)
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
        void handle.stop().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error('[nekro-nxt] 关闭失败：', error instanceof Error ? error.message : error)
            process.exit(1)
          },
        )
      }
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
    } catch (error) {
      console.error('[nekro-nxt] 启动失败：', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })()
}
