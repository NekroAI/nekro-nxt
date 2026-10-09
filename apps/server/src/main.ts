import { configureDshLlmProviders } from './dsh-host-profile.js'
import { DSH_RUNTIME_FINGERPRINT, DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import { acquireDataRootLease } from './data-root-lease.js'
import { createUpgradeBackup, restoreUpgradeBackup, writeUpgradeJson } from './upgrade-backup.js'
import { createUpgradeProgress, markUpgradeProgressFailure } from './upgrade-progress.js'
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
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { Context as LlmContext } from '@deepseek-ai/cordis'
import { HostUpgradeCoordinator, type UpgradeJournal } from '@nekro-nxt/client-migrations'
import { InstanceDescriptorSchema } from '@nekro-nxt/contracts'
import {
  createSqliteBackupSet,
  readBackupAgentIds,
  preflightDshSessionStorage,
  type SqliteBackupSource,
} from '@nekro-nxt/storage-sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { NekroRuntime } from './bootstrap.js'
import { createNekroHostApi } from './host-api.js'
import { initializeServerIdentity, startManagementEdge, type ManagementEdgeHandle } from './management-edge.js'
import { DEEPSEEK_HARNESS_VERSION } from './dsh-version.js'
import { PRODUCT_VERSION } from './product-version.js'

const resolveRoot = (input: string): string => (path.isAbsolute(input) ? input : path.resolve(process.cwd(), input))

const PROVIDER_ROUTE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const SERVER_PACKAGE_NAME = '@nekro-nxt/server'
const SERVER_PACKAGE_VERSION = PRODUCT_VERSION

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

export const isLoopbackListenHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127')

export const parseManagementKey = (input: string | undefined, required = false): string | undefined => {
  if (input === undefined || input.trim() === '') {
    if (required) throw new TypeError('容器或公开监听必须设置 NEKRO_MANAGEMENT_KEY。')
    return undefined
  }
  if (input.length < 32) throw new TypeError('NEKRO_MANAGEMENT_KEY 至少需要 32 个字符。')
  return input
}

/** `NEKRO_TRUST_PROXY=1` (or `true`) only when a reverse proxy in front terminates HTTPS and sets forwarded headers. */
export const parseTrustProxy = (input: string | undefined): boolean => {
  if (input === undefined || input.trim() === '' || input === '0' || input === 'false') return false
  if (input === '1' || input === 'true') return true
  throw new TypeError(`NEKRO_TRUST_PROXY 只能是 1 或 0：${input}`)
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

export { configureDshLlmProviders } from './dsh-host-profile.js'

export const defaultWebDistIndex = (): string => fileURLToPath(new URL('../../web/dist/index.html', import.meta.url))
export const defaultDataRoot = (): string => fileURLToPath(new URL('../../../data', import.meta.url))

/**
 * Product-owned client routes. DSH's rc.2 static fallback intentionally returns 404 for unknown paths. The retired
 * client prefixes still serve the index so a saved Desktop route or an old bookmark opens the app (which then
 * lands on its home) instead of a blank 404.
 */
export const NEKRO_SPA_ROUTE_PREFIXES = [
  '/live',
  '/channels',
  '/agents',
  '/workshop',
  '/community',
  '/wiring',
  '/settings',
  '/apps',
  // Retired client prefixes.
  '/work',
  '/creator',
  '/runtime',
  '/connections',
  '/users',
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
  const record: ReleaseSqliteBackupRecord = {
    format: 'nxt.server-release-sqlite-backup',
    version: 1,
    releaseId,
    backupId,
    databases: sources.map((source) => source.name),
  }
  const stagingRoot = await mkdtemp(`${destination}.staging-`)
  const stagingDestination = path.join(stagingRoot, 'backup')
  try {
    if (sources.length === 0) {
      await mkdir(stagingDestination, { mode: 0o700 })
    } else {
      await createSqliteBackupSet(sources, stagingDestination)
    }
    await writeFile(path.join(stagingDestination, 'release.json'), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(stagingDestination, destination)
    return record
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

const upgradeJournalSchema = z
  .object({
    format: z.literal('nxt.server-upgrade-journal'),
    version: z.literal(1),
    releaseId: z.string().min(1),
    status: z.enum(['migrating', 'ready', 'recovery']),
    backupId: z.string().optional(),
    updatedAt: z.number().int().safe().nonnegative(),
    steps: z.record(
      z.string(),
      z
        .object({
          status: z.enum(['running', 'completed', 'failed']),
          attempts: z.number().int().positive(),
          startedAt: z.number().int().safe().nonnegative(),
          completedAt: z.number().int().safe().nonnegative().optional(),
          errorSummary: z.string().max(512).optional(),
        })
        .strict(),
    ),
    errorSummary: z.string().max(512).optional(),
  })
  .strict()

export type ServerUpgradeJournalRecord = z.output<typeof upgradeJournalSchema>

const upgradeIdentity = (releaseId: string): string => createHash('sha256').update(releaseId).digest('hex')

const createServerUpgradeJournal = async (
  backupRoot: string,
  releaseId: string,
  getBackupId: () => string | undefined,
): Promise<UpgradeJournal & { readonly finish: (status: 'ready' | 'recovery', error?: string) => Promise<void> }> => {
  const journalPath = path.join(backupRoot, `upgrade-${upgradeIdentity(releaseId)}.json`)
  let record: ServerUpgradeJournalRecord
  try {
    record = upgradeJournalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')))
    if (record.releaseId !== releaseId) throw new Error('Host upgrade journal release identity mismatch.')
  } catch (error) {
    if (!isMissing(error)) throw error
    record = {
      format: 'nxt.server-upgrade-journal',
      version: 1,
      releaseId,
      status: 'migrating',
      updatedAt: Date.now(),
      steps: {},
    }
  }
  const publish = async (next: ServerUpgradeJournalRecord): Promise<void> => {
    const temporary = `${journalPath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(upgradeJournalSchema.parse(next), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    try {
      await rename(temporary, journalPath)
      record = next
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const withBackup = <T extends ServerUpgradeJournalRecord>(next: T): T => {
    const backupId = getBackupId()
    return { ...next, ...(backupId === undefined ? {} : { backupId }) }
  }
  return {
    begin: async (id) => {
      const previous = record.steps[id]
      const now = Date.now()
      await publish(
        withBackup({
          ...record,
          status: 'migrating',
          updatedAt: now,
          steps: {
            ...record.steps,
            [id]: {
              status: 'running',
              attempts: (previous?.attempts ?? 0) + 1,
              startedAt: now,
            },
          },
        }),
      )
    },
    complete: async (id) => {
      const current = record.steps[id]
      if (!current) throw new Error(`Host upgrade journal has not begun step: ${id}`)
      await publish(
        withBackup({
          ...record,
          updatedAt: Date.now(),
          steps: {
            ...record.steps,
            [id]: { ...current, status: 'completed', completedAt: Date.now() },
          },
        }),
      )
    },
    fail: async (id, error) => {
      const current = record.steps[id]
      if (!current) throw new Error(`Host upgrade journal has not begun step: ${id}`)
      const errorSummary = (error instanceof Error ? error.message : String(error)).slice(0, 512)
      await publish(
        withBackup({
          ...record,
          status: 'recovery',
          updatedAt: Date.now(),
          steps: { ...record.steps, [id]: { ...current, status: 'failed', errorSummary } },
          errorSummary,
        }),
      )
    },
    finish: async (status, error) => {
      await publish(
        withBackup({
          ...record,
          status,
          updatedAt: Date.now(),
          ...(error === undefined ? { errorSummary: undefined } : { errorSummary: error.slice(0, 512) }),
        }),
      )
    },
  }
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

const acquireUpgradeFileLock = async (backupRoot: string, releaseId: string): Promise<() => Promise<void>> => {
  const lockPath = path.join(backupRoot, 'upgrade.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(
          `${JSON.stringify({ format: 'nxt.server-upgrade-lock', version: 2, releaseId, pid: process.pid, token })}\n`,
          'utf8',
        )
      } catch (error) {
        await handle.close()
        await rm(lockPath, { force: true })
        throw error
      }
      return async () => {
        await handle.close()
        const current = z
          .object({ token: z.unknown().optional() })
          .passthrough()
          .parse(JSON.parse(await readFile(lockPath, 'utf8')))
        if (current.token !== token) throw new Error('Host upgrade lock ownership changed before release.')
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const current = z
        .object({
          format: z.literal('nxt.server-upgrade-lock'),
          version: z.union([z.literal(1), z.literal(2)]),
          releaseId: z.string(),
          pid: z.number().int().positive(),
          token: z.string().uuid(),
        })
        .strict()
        .parse(JSON.parse(await readFile(lockPath, 'utf8')))
      if (current.version === 1 && current.pid !== process.pid && processIsAlive(current.pid)) {
        throw new Error(`另一个 NekroNXT 正在升级这个数据目录（PID ${current.pid}，版本 ${current.releaseId}）`)
      }
      await rename(lockPath, `${lockPath}.stale-${current.token}`)
    }
  }
  throw new Error('Cannot acquire the upgrade lock.')
}

const createRuntimeThroughUpgradeCoordinator = async (
  dataRoot: string,
  releaseId: string,
  options: Parameters<typeof NekroRuntime.create>[0],
  signal?: AbortSignal,
  onCreated?: (runtime: NekroRuntime) => void,
  prepareNetwork?: (runtime: NekroRuntime) => Promise<void>,
): Promise<NekroRuntime> => {
  const backupRoot = path.join(dataRoot, 'backups')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  let backupId: string | undefined
  let runtime: NekroRuntime | undefined
  let sourceRuntimeFingerprint: string | undefined
  const journal = await createServerUpgradeJournal(backupRoot, releaseId, () => backupId)
  const progress = createUpgradeProgress(dataRoot, releaseId)
  await progress.update({ phase: 'preflight' })
  const coordinator = new HostUpgradeCoordinator({
    lock: { acquire: () => acquireUpgradeFileLock(backupRoot, releaseId) },
    preflight: async () => {
      const info = await stat(dataRoot)
      if (!info.isDirectory()) throw new Error(`Host 数据根不是目录：${dataRoot}`)
      await existingSqliteSources(dataRoot)
      await preflightDshSessionStorage({
        databasePath: options.sessionDatabasePath,
        sessionCompatibilityId: DSH_RUNTIME_RELEASE.sessionCompatibilityId,
      })
      try {
        const identity = z
          .object({
            format: z.literal('nxt.runtime-identity'),
            version: z.literal(1),
            runtimeFingerprint: z.string(),
            releaseId: z.string(),
            sessionCompatibilityId: z.string(),
            settingsFormatVersion: z.number().int(),
          })
          .strict()
          .parse(JSON.parse(await readFile(path.join(dataRoot, 'dsh', 'runtime-identity.json'), 'utf8')))
        sourceRuntimeFingerprint = identity.runtimeFingerprint
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    },
    createBackup: async () => {
      const externalRoots = externalWorkspaceBackupRoots(dataRoot, options.developmentWorkspaceRoot)
      const backup = await createUpgradeBackup({
        dataRoot,
        releaseId,
        runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
        ...(sourceRuntimeFingerprint === undefined ? {} : { sourceRuntimeFingerprint }),
        externalRoots,
        ...(signal === undefined ? {} : { signal }),
        onProgress: (completed, total) => progress.progress(completed, total),
      })
      backupId = backup.backupId
      return { id: backup.backupId }
    },
    steps: [
      {
        id: 'storage-owners-open-v1',
        run: async () => {
          runtime = await NekroRuntime.create(options)
          onCreated?.(runtime)
        },
      },
      {
        id: 'runtime-recovery-v1',
        phase: 'checking',
        run: async () => {
          if (!runtime) throw new Error('Host Runtime storage step did not produce a Runtime.')
          await runtime.start()
          await runtime.recover({ openAdmission: false })
        },
      },
      {
        id: 'network-prepare-v1',
        phase: 'checking',
        run: async () => {
          if (!runtime) throw new Error('Host Runtime has not recovered.')
          await prepareNetwork?.(runtime)
        },
      },
      {
        id: 'runtime-activation-v1',
        phase: 'activating',
        run: async () => {
          if (!runtime) throw new Error('Host Runtime has not recovered.')
          await runtime.openAdmission()
        },
      },
    ],
    journal,
    ...(signal === undefined ? {} : { signal }),
  })
  const offProgress = coordinator.subscribe(() => {
    void progress.update(coordinator.getSnapshot()).catch(() => undefined)
  })
  let status
  try {
    status = await coordinator.run()
  } finally {
    offProgress()
    await progress.close()
  }
  if (status.phase !== 'ready' || !runtime) {
    const summary = status.errorSummary ?? 'Upgrade did not reach ready.'
    await journal.finish('recovery', summary)
    throw new Error(`升级失败：${summary}`)
  }
  await journal.finish('ready')
  await writeUpgradeJson(path.join(dataRoot, 'dsh', 'runtime-identity.json'), {
    format: 'nxt.runtime-identity',
    version: 1,
    releaseId,
    runtimeFingerprint: DSH_RUNTIME_FINGERPRINT,
    sessionCompatibilityId: DSH_RUNTIME_RELEASE.sessionCompatibilityId,
    settingsFormatVersion: DSH_RUNTIME_RELEASE.settingsFormatVersion,
  })
  runtime.upgradeBackupId = backupId
  return runtime
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
  readonly host?: string
  readonly port?: number
  /** Non-secret immutable image/application release identity exposed by readiness. */
  readonly releaseId?: string
  readonly signal?: AbortSignal
  /** Enables the automatic TLS edge and device authentication. Never persisted. */
  readonly managementKey?: string
  /** The edge sits behind a reverse proxy that terminates HTTPS; trust its forwarded protocol and host. */
  readonly trustProxy?: boolean
  /** Optional real LLM adapter wiring for a non-test server. */
  readonly configureLlm?: (context: LlmContext) => Promise<void> | void
}

export interface NekroServerHandle {
  readonly port: number
  readonly secure: boolean
  stop(): Promise<void>
}

const startLeasedServer = async (
  options: StartServerOptions,
  owner: { runtime?: NekroRuntime; web?: Context; edge?: ManagementEdgeHandle },
): Promise<NekroServerHandle> => {
  const requestedHost = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const managementKey = parseManagementKey(options.managementKey, !isLoopbackListenHost(requestedHost))
  if (requestedHost !== '127.0.0.1' && requestedHost !== '0.0.0.0') {
    throw new TypeError(`Server 当前不支持监听 host：${requestedHost}`)
  }
  const host = requestedHost
  const releaseId = parseReleaseId(options.releaseId)
  const dataRoot = resolveRoot(options.dataRoot)
  const developmentWorkspaceRoot = resolveRoot(options.developmentWorkspaceRoot ?? path.join(dataRoot, 'workspaces'))
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(developmentWorkspaceRoot, { recursive: true, mode: 0o700 })
  let ready = false
  let network: NekroServerHandle | undefined
  await createRuntimeThroughUpgradeCoordinator(
    dataRoot,
    releaseId,
    {
      deferAdmission: true,
      coreDatabasePath: path.join(dataRoot, 'core.sqlite'),
      sessionDatabasePath: path.join(dataRoot, 'sessions.sqlite'),
      assetRoot: path.join(dataRoot, 'assets'),
      extensionDataRoot: path.join(dataRoot, 'extension-data'),
      extensionCacheRoot: path.join(dataRoot, 'extension-cache'),
      credentialRoot: path.join(dataRoot, 'credentials'),
      llmSettingsPath: path.join(dataRoot, 'dsh', 'settings.yaml'),
      llmCredentialPath: path.join(dataRoot, 'dsh', '.credentials.yaml'),
      developmentWorkspaceRoot,
      // 默认连接正式社区；测试站或本地社区开发服务用 NEKRO_COMMUNITY_URL 覆盖。
      community: { url: process.env['NEKRO_COMMUNITY_URL'] },
      ...(options.configureLlm === undefined ? {} : { configureLlm: options.configureLlm }),
    },
    options.signal,
    (created) => {
      owner.runtime = created
    },
    async (created) => {
      network = await prepareNetwork(created)
    },
  )
  options.signal?.throwIfAborted()
  if (!network) throw new Error('Host network was not prepared.')
  ready = true
  return network

  async function prepareNetwork(runtime: NekroRuntime): Promise<NekroServerHandle> {
    options.signal?.throwIfAborted()
    // The HTTP/SSE host owns a narrow Cordis Context with the WebServer seam and
    // the static dist fallback. The DSH Session runtime stays inside NekroRuntime.
    const webContext = new Context()
    owner.web = webContext
    await webContext.plugin(WebServer, {
      host: managementKey === undefined ? host : '127.0.0.1',
      port: managementKey === undefined ? port : 0,
    })
    // Public static helper; NXT's management edge owns authentication. The upstream
    // plugin now injects its native Connection service, which this Host does not use.
    const distIndex = resolveRoot(options.distIndex)
    webContext.effect(
      () =>
        webContext.webServer.registerFallback(async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' })
            response.end()
            return
          }
          let pathname: string
          try {
            pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
          } catch {
            response.writeHead(400)
            response.end()
            return
          }
          await serveStatic(
            pathname,
            response,
            path.dirname(distIndex),
            distIndex,
            () => true,
            async () => webContext.webServer.renderIndex(await readFile(distIndex, 'utf8')),
          )
        }),
      'nekro-nxt: static product frontend',
    )
    const disposeSpaRoutes = registerNekroSpaRoutes(webContext.webServer, distIndex)
    webContext.effect(() => disposeSpaRoutes, 'nekro-nxt: product SPA routes')
    const api = createNekroHostApi(
      webContext.webServer,
      runtime,
      {
        displayName: 'NekroNXT',
        organizationName: 'NekroAI',
        version: SERVER_PACKAGE_VERSION,
        releaseId,
        repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
        licenseSpdx: 'AGPL-3.0-only',
        dshVersion: DEEPSEEK_HARNESS_VERSION,
      },
      () => ready,
    )
    webContext.effect(() => () => api.dispose(), 'nekro-nxt: product HTTP API')
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
          const available = status === 'live' || ready
          const body = JSON.stringify({ status: available ? status : 'starting', releaseId })
          response.writeHead(available ? 200 : 503, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          response.end(request.method === 'HEAD' ? undefined : body)
        },
      })
    const disposeLive = registerHealthRoute('/health/live', 'live')
    const disposeReady = registerHealthRoute('/health/ready', 'ready')

    const disposeLoopbackDescriptor =
      managementKey === undefined
        ? webContext.webServer.register({
            kind: 'exact',
            path: '/.well-known/nekro-nxt',
            handler: (request, response) => {
              if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
                response.end()
                return
              }
              const descriptor = InstanceDescriptorSchema.parse({
                format: 'nxt.instance-descriptor',
                descriptorVersion: 1,
                instanceId: initializeServerIdentity(runtime.hostSecurity, undefined, Date.now()),
                releaseId,
                productVersion: SERVER_PACKAGE_VERSION,
                managementProtocol: 1,
                desktopChromeProtocol: 1,
                transport: 'loopback-http',
              })
              const body = JSON.stringify(descriptor)
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
              })
              response.end(request.method === 'HEAD' ? undefined : body)
            },
          })
        : undefined

    let managementEdge: ManagementEdgeHandle | undefined
    if (managementKey !== undefined) {
      try {
        managementEdge = await startManagementEdge({
          host,
          port,
          internalPort: webContext.webServer.port,
          dataRoot,
          managementKey,
          releaseId,
          productVersion: SERVER_PACKAGE_VERSION,
          repository: runtime.hostSecurity,
          ...(options.trustProxy === true ? { trustProxy: true } : {}),
        })
        owner.edge = managementEdge
      } catch (error) {
        disposeReady()
        disposeLive()
        disposeLoopbackDescriptor?.()
        api.dispose()
        disposeSpaRoutes()
        await webContext.fiber.dispose()
        await runtime.dispose()
        throw error
      }
    }

    let stopped = false
    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      await managementEdge?.stop()
      disposeLoopbackDescriptor?.()
      disposeReady()
      disposeLive()
      api.dispose()
      disposeSpaRoutes()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }

    options.signal?.throwIfAborted()
    return { port: managementEdge?.port ?? webContext.webServer.port, secure: managementEdge !== undefined, stop }
  }
}

/** One lease covers backup, migration, serving, and quiescent teardown. */
export const startNekroServer = async (options: StartServerOptions): Promise<NekroServerHandle> => {
  const requestedHost = options.host ?? '127.0.0.1'
  parseManagementKey(options.managementKey, !isLoopbackListenHost(requestedHost))
  const release = await acquireDataRootLease(resolveRoot(options.dataRoot))
  const owner: { runtime?: NekroRuntime; web?: Context; edge?: ManagementEdgeHandle } = {}
  try {
    const server = await startLeasedServer(options, owner)
    options.signal?.throwIfAborted()
    let stopping: Promise<void> | undefined
    return { ...server, stop: () => (stopping ??= server.stop().then(() => release())) }
  } catch (error) {
    let progressFailure: unknown
    await markUpgradeProgressFailure(
      resolveRoot(options.dataRoot),
      parseReleaseId(options.releaseId),
      error instanceof Error ? error.message.slice(0, 512) : '启动失败。',
    ).catch((failure: unknown) => {
      progressFailure = failure
    })
    const cleanup = await Promise.allSettled([owner.edge?.stop(), owner.web?.fiber.dispose(), owner.runtime?.dispose()])
    const failures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError([error, ...failures], 'Host 启动失败且资源未静止，数据根锁保持占用。')
    await release()
    if (progressFailure !== undefined)
      throw new AggregateError([error, progressFailure], 'Host 启动失败，诊断写入也未完成。')
    throw error
  }
}

const externalWorkspaceBackupRoots = (dataRoot: string, workspaceRoot?: string) => {
  if (workspaceRoot === undefined || path.resolve(workspaceRoot) === path.join(path.resolve(dataRoot), 'workspaces'))
    return []
  const root = path.resolve(workspaceRoot)
  const databasePath = path.join(dataRoot, 'core.sqlite')
  if (!existsSync(databasePath)) return []
  return readBackupAgentIds(databasePath).flatMap((id, index) => {
    const target = path.join(root, id)
    return existsSync(target) ? [{ key: `workspace-${index}`, target }] : []
  })
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
      const restoreIndex = process.argv.indexOf('--restore-upgrade')
      if (restoreIndex >= 0) {
        const backupId = process.argv[restoreIndex + 1]
        if (!backupId) throw new Error('--restore-upgrade 需要恢复点 ID。')
        const release = await acquireDataRootLease(resolveRoot(dataRoot))
        try {
          await restoreUpgradeBackup({
            dataRoot: resolveRoot(dataRoot),
            backupId,
            ...(developmentWorkspaceRoot === undefined ? {} : { externalWorkspaceRoot: developmentWorkspaceRoot }),
          })
          console.log('升级前数据已恢复。请退出新版本并启动匹配的旧程序包。')
        } finally {
          await release()
        }
        return
      }
      const distIndexEnv = process.env['NEKRO_DIST_INDEX']
      const portEnv = process.env['NEKRO_PORT']
      const host = parseListenHost(process.env['NEKRO_HOST'])
      const managementKey = parseManagementKey(process.env['NEKRO_MANAGEMENT_KEY'], host === '0.0.0.0')
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
      const startup = new AbortController()
      const cancelStartup = () => startup.abort(new Error('用户取消升级启动。'))
      const parentPort = 'parentPort' in process ? process.parentPort : undefined
      const control = z.object({
        format: z.literal('nxt.host-control'),
        version: z.literal(1),
        action: z.literal('cancel'),
        runId: z.string(),
      })
      const receiveControl = (event: { readonly data?: unknown }) => {
        const parsed = control.safeParse(event.data)
        if (parsed.success && parsed.data.runId === process.env['NEKRO_UPGRADE_RUN_ID']) cancelStartup()
      }
      if (
        typeof parentPort === 'object' &&
        parentPort !== null &&
        'on' in parentPort &&
        typeof parentPort.on === 'function'
      ) {
        parentPort.on('message', receiveControl)
      }
      process.on('SIGTERM', cancelStartup)
      process.on('SIGINT', cancelStartup)
      const handle = await startNekroServer({
        signal: startup.signal,
        dataRoot,
        distIndex,
        host,
        port,
        releaseId,
        ...(managementKey === undefined ? {} : { managementKey }),
        ...(parseTrustProxy(process.env['NEKRO_TRUST_PROXY']) ? { trustProxy: true } : {}),
        ...(developmentWorkspaceRoot === undefined || developmentWorkspaceRoot.trim() === ''
          ? {}
          : { developmentWorkspaceRoot }),
        configureLlm: configureDshLlmProviders(llmProviderRoutes),
      })
      process.removeListener('SIGTERM', cancelStartup)
      process.removeListener('SIGINT', cancelStartup)
      console.log(
        handle.secure
          ? `[nekro-nxt] Server ${releaseId} 已监听 https://${host}:${handle.port}（同一端口也接受 http://，浏览器访问需输入管理密钥登录）`
          : `[nekro-nxt] Server ${releaseId} 已监听 http://${host}:${handle.port}`,
      )
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
