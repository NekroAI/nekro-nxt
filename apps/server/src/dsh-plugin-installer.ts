import {
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  DshNxtHostUiSchema,
  JsonValueSchema,
  type DshPluginEntryRecord,
  type DshPluginInstallSource,
  type DshPluginPackageRecord,
  type DshNxtHostUi,
} from '@nekro-nxt/contracts'
import { canonicalJson } from '@nekro-nxt/core'
import { validateHostUiCss, validateHostUiSvg } from '@nekro-nxt/extension-runtime'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { DshPluginRepository } from '@nekro-nxt/storage-sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { monotonicFactory } from 'ulid'
import { create as createTarball } from 'tar'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'

const MAX_TARBALL_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024
const INSTALL_TIMEOUT_MS = 5 * 60_000
const INSPECTION_TTL_MS = 10 * 60_000

const packageManifestSchema = z
  .object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
    dependencies: z.record(z.string(), z.string()).optional(),
    dsh: z
      .object({
        bundle: z
          .object({ patch: z.string().trim().min(1) })
          .strict()
          .optional(),
        client: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    nekroNxt: z.object({ hostUi: DshNxtHostUiSchema.optional() }).passthrough().optional(),
  })
  .passthrough()

export interface DshPluginInstallInspection {
  readonly token: string
  readonly packageName: string
  readonly packageVersion: string
  readonly packageDigest: string
  readonly lockfileDigest: string
  readonly blockedBuilds: readonly string[]
  readonly clientUiDetected: boolean
  readonly hostUi?: DshNxtHostUi
  readonly entries: readonly {
    readonly entryKey: string
    readonly moduleName: string
    readonly suggestedScope: 'host' | 'agent'
  }[]
}

export type DshPluginInstallPhase = 'download' | 'dependencies' | 'build-scripts' | 'validation' | 'publish'
export type DshPluginInstallProgress = (phase: DshPluginInstallPhase, message: string) => void

interface PendingInspection {
  readonly token: string
  readonly expiresAt: number
  readonly packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>
  readonly source: DshPluginInstallSource
  readonly stagingDirectory: string
  readonly projectDirectory: string
  readonly manifest: z.output<typeof packageManifestSchema>
  readonly packageDigest: string
  readonly lockfileDigest: string
  readonly integrity?: string
  readonly blockedBuilds: readonly string[]
  readonly buildAllowKeys: Readonly<Record<string, readonly string[]>>
  readonly entries: readonly Omit<DshPluginEntryRecord, 'packageId' | 'createdAt'>[]
}

export interface DshPluginImportExpectation {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageDigest: string
  readonly lockfileDigest: string
  readonly integrity?: string
  readonly entries: readonly { readonly entryKey: string; readonly moduleName: string }[]
}

const sha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex')
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isAgentLikeModule = (name: string): boolean => /(?:^|[-/])(tool|prompt|preset|skill)(?:$|[-/])/iu.test(name)

const canonicalizeFuturePath = (input: string): string => {
  const missing: string[] = []
  let cursor = path.resolve(input)
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    missing.unshift(path.basename(cursor))
    cursor = parent
  }
  return path.join(realpathSync.native(cursor), ...missing)
}

const assertInside = (root: string, target: string): void => {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`DSH 插件路径逃逸受管包目录：${target} 不在 ${root} 内。`)
  }
}

const hashDirectory = async (root: string): Promise<string> => {
  const hash = createHash('sha256')
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isSymbolicLink()) throw new Error(`DSH 插件包包含不允许的符号链接：${relative}`)
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`)
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) throw new Error(`DSH 插件包包含不支持的文件类型：${relative}`)
      const content = await readFile(absolute)
      bytes += content.byteLength
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('DSH 插件解包后内容超过 256 MiB 限制。')
      hash.update(`f\0${relative}\0${content.byteLength}\0`)
      hash.update(content)
    }
  }
  await visit(root)
  return hash.digest('hex')
}

const normalizeRootLockKey = (key: string, packageName: string, packageVersion: string): string => {
  if (!key.startsWith(`${packageName}@`)) return key
  const identity = key.slice(packageName.length + 1)
  if (identity !== packageVersion && !identity.startsWith(`${packageVersion}(`) && !identity.startsWith('file:')) {
    return key
  }
  const peerSuffix = identity.includes('(') ? identity.slice(identity.indexOf('(')) : ''
  return `$root@${packageVersion}${peerSuffix}`
}

const dependencyLockDigest = (lockfile: Uint8Array, packageName: string, packageVersion: string): string => {
  const parsed = z
    .object({
      lockfileVersion: z.union([z.string(), z.number()]),
      settings: z.record(z.string(), z.unknown()).optional(),
      overrides: z.record(z.string(), z.unknown()).optional(),
      packages: z.record(z.string(), z.unknown()).default({}),
      snapshots: z.record(z.string(), z.unknown()).default({}),
    })
    .passthrough()
    .parse(parseYaml(Buffer.from(lockfile).toString('utf8')))
  const normalizeTable = (table: Readonly<Record<string, unknown>>, stripRootResolution: boolean) =>
    Object.fromEntries(
      Object.entries(table)
        .map(([key, value]) => {
          const normalizedKey = normalizeRootLockKey(key, packageName, packageVersion)
          if (!stripRootResolution || normalizedKey === key || typeof value !== 'object' || value === null) {
            return [normalizedKey, value] as const
          }
          const normalizedValue = { ...z.record(z.string(), z.unknown()).parse(value) }
          delete normalizedValue['resolution']
          return [normalizedKey, normalizedValue] as const
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    )
  const normalized = JsonValueSchema.parse({
    lockfileVersion: parsed.lockfileVersion,
    settings: parsed.settings ?? {},
    overrides: parsed.overrides ?? {},
    packages: normalizeTable(parsed.packages, true),
    snapshots: normalizeTable(parsed.snapshots, false),
  })
  return sha256(canonicalJson(normalized))
}

const registryIntegrity = (lockfile: Uint8Array, packageName: string, packageVersion: string): string | undefined => {
  const parsed = z
    .object({ packages: z.record(z.string(), z.unknown()).default({}) })
    .passthrough()
    .parse(parseYaml(Buffer.from(lockfile).toString('utf8')))
  const root = parsed.packages[`${packageName}@${packageVersion}`]
  const entry = z
    .object({ resolution: z.object({ integrity: z.string().optional() }).passthrough().optional() })
    .passthrough()
    .safeParse(root)
  if (!entry.success) return undefined
  const integrity = entry.data.resolution?.integrity
  return typeof integrity === 'string' && integrity.length > 0 ? integrity : undefined
}

export class DshPluginPackageInstaller {
  readonly #repository: DshPluginRepository
  readonly #root: string
  readonly #storeDirectory: string
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #pending = new Map<string, PendingInspection>()
  readonly #pnpmCli: string
  #initializePromise: Promise<void> | undefined

  constructor(
    repository: DshPluginRepository,
    root: string,
    options: { readonly now?: () => number; readonly nextUlid?: () => string } = {},
  ) {
    if (!path.isAbsolute(root)) throw new TypeError('DSH plugin package root must be absolute.')
    this.#repository = repository
    this.#root = canonicalizeFuturePath(root)
    this.#storeDirectory = path.join(this.#root, 'pnpm-store')
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('pnpm')
    this.#pnpmCli = path.join(path.dirname(manifest), 'bin', 'pnpm.mjs')
  }

  async initialize(): Promise<void> {
    this.#initializePromise ??= (async () => {
      const staging = path.join(this.#root, 'plugin-staging')
      const packages = path.join(this.#root, 'plugin-packages')
      const trash = path.join(this.#root, 'plugin-trash')
      await Promise.all([
        mkdir(packages, { recursive: true, mode: 0o700 }),
        mkdir(staging, { recursive: true, mode: 0o700 }),
        mkdir(trash, { recursive: true, mode: 0o700 }),
        mkdir(this.#storeDirectory, { recursive: true, mode: 0o700 }),
      ])
      const interrupted = await readdir(staging, { withFileTypes: true })
      await Promise.all(
        interrupted.map((entry) => rm(path.join(staging, entry.name), { recursive: true, force: true })),
      )
      const committed = new Set<string>(this.#repository.listDshPluginPackages().map(({ id }) => id))
      const installed = await readdir(packages, { withFileTypes: true })
      await Promise.all(
        installed
          .filter((entry) => entry.isDirectory() && !committed.has(entry.name))
          .map((entry) =>
            rename(
              path.join(packages, entry.name),
              path.join(trash, `orphan-${entry.name}-${this.#timestamp()}-${randomUUID()}`),
            ),
          ),
      )
    })()
    await this.#initializePromise
  }

  inspectRegistry(spec: string, onProgress?: DshPluginInstallProgress): Promise<DshPluginInstallInspection> {
    const normalized = spec.trim()
    if (!normalized || /^(?:https?|git|file|link):/iu.test(normalized)) {
      return Promise.reject(new Error('只允许 npm registry 包名或版本范围，不允许任意 URL。'))
    }
    return this.#inspect('registry', normalized, undefined, undefined, onProgress)
  }

  async inspectTarball(
    content: Uint8Array,
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginInstallInspection> {
    return this.#inspectTarball(content, 'tarball', undefined, onProgress)
  }

  async inspectImportedTarball(
    content: Uint8Array,
    expected: DshPluginImportExpectation,
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginInstallInspection> {
    return this.#inspectTarball(content, 'imported', expected, onProgress)
  }

  async #inspectTarball(
    content: Uint8Array,
    source: 'tarball' | 'imported',
    expected?: DshPluginImportExpectation,
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginInstallInspection> {
    await this.initialize()
    if (content.byteLength === 0 || content.byteLength > MAX_TARBALL_BYTES) {
      throw new Error('DSH 插件 tgz 必须大于 0 且不超过 64 MiB。')
    }
    const stagingRoot = path.join(this.#root, 'plugin-staging', `upload-${randomUUID()}`)
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    const tarball = path.join(stagingRoot, 'package.tgz')
    await writeFile(tarball, content, { mode: 0o600 })
    onProgress?.('download', '上传包已写入受管 staging。')
    try {
      return await this.#inspect(source, tarball, stagingRoot, expected, onProgress)
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true })
      throw error
    }
  }

  async exportRootTarball(packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>): Promise<Uint8Array> {
    const packageRecord = this.#repository.getDshPluginPackage(packageId)
    if (!packageRecord) throw new Error('DSH 插件包不存在。')
    const packageRoot = await realpath(
      path.join(this.projectDirectory(packageId), 'node_modules', packageRecord.packageName),
    )
    assertInside(this.#root, packageRoot)
    const staging = path.join(this.#root, 'plugin-staging', `export-${randomUUID()}`)
    const output = path.join(staging, 'package.tgz')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const entries = (await readdir(packageRoot, { withFileTypes: true }))
        .filter((entry) => entry.name !== 'node_modules')
        .map((entry) => entry.name)
      await createTarball({ cwd: packageRoot, file: output, gzip: true, portable: true }, entries)
      const content = await readFile(output)
      if (content.byteLength > MAX_TARBALL_BYTES) throw new Error('DSH 插件导出 tgz 超过 64 MiB。')
      return content
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async commit(
    token: string,
    approvedBuilds: readonly string[],
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginPackageRecord> {
    await this.#cleanupExpiredInspections()
    const pending = this.#pending.get(token)
    if (!pending) throw new Error('DSH 插件安装检查已失效，请重新检查。')
    const approved = [...new Set(approvedBuilds)].sort()
    const unexpected = approved.filter((name) => !pending.blockedBuilds.includes(name))
    if (unexpected.length) throw new Error(`安装脚本批准列表包含未检测到的依赖：${unexpected.join(', ')}`)
    if (pending.blockedBuilds.length) {
      onProgress?.('build-scripts', '正在执行用户批准的依赖构建脚本。')
      const allowBuilds = Object.fromEntries(
        Object.entries(pending.buildAllowKeys).flatMap(([name, keys]) =>
          keys.map((key) => [key, approved.includes(name)] as const),
        ),
      )
      await writeFile(path.join(pending.projectDirectory, 'pnpm-workspace.yaml'), stringifyYaml({ allowBuilds }), {
        mode: 0o600,
      })
      await this.#runPnpm(pending.projectDirectory, ['rebuild', '--pending'])
      try {
        await this.#runPnpm(pending.projectDirectory, ['install', '--force', '--frozen-lockfile'])
      } catch (error) {
        const match = /Ignored build scripts:\s*([^\r\n]+)/u.exec(messageOf(error))
        const exactKeys =
          match?.[1]
            ?.split(',')
            .map((value) => value.trim())
            .filter(Boolean) ?? []
        if (!messageOf(error).includes('ERR_PNPM_IGNORED_BUILDS') || exactKeys.length === 0) throw error
        for (const key of exactKeys) {
          const name = pending.blockedBuilds.find((candidate) => key === candidate || key.startsWith(`${candidate}@`))
          if (!name) throw error
          allowBuilds[key] = approved.includes(name)
        }
        await writeFile(path.join(pending.projectDirectory, 'pnpm-workspace.yaml'), stringifyYaml({ allowBuilds }), {
          mode: 0o600,
        })
        await this.#runPnpm(pending.projectDirectory, ['install', '--force', '--frozen-lockfile'])
      }
    }
    const installedAt = this.#timestamp()
    onProgress?.('publish', '依赖和入口校验通过，正在原子提交安装事实。')
    const finalDirectory = this.packageDirectory(pending.packageId)
    await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 })
    await rename(pending.stagingDirectory, finalDirectory)
    const packageRecord: DshPluginPackageRecord = {
      id: pending.packageId,
      packageName: pending.manifest.name,
      packageVersion: pending.manifest.version,
      source: pending.source,
      packageDigest: pending.packageDigest,
      ...(pending.integrity === undefined ? {} : { integrity: pending.integrity }),
      lockfileDigest: pending.lockfileDigest,
      manifest: JsonValueSchema.parse(pending.manifest),
      approvedBuilds: approved,
      installedAt,
    }
    try {
      this.#repository.saveDshPluginPackage({
        package: packageRecord,
        entries: pending.entries.map((entry) => ({ ...entry, packageId: pending.packageId, createdAt: installedAt })),
      })
    } catch (error) {
      await rm(finalDirectory, { recursive: true, force: true })
      throw error
    } finally {
      this.#pending.delete(token)
    }
    return packageRecord
  }

  cancel(token: string): Promise<void> {
    const pending = this.#pending.get(token)
    if (!pending) return Promise.resolve()
    this.#pending.delete(token)
    return rm(pending.stagingDirectory, { recursive: true, force: true })
  }

  packageDirectory(packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>): string {
    const result = path.join(this.#root, 'plugin-packages', packageId)
    assertInside(path.join(this.#root, 'plugin-packages'), result)
    return result
  }

  projectDirectory(packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>): string {
    return path.join(this.packageDirectory(packageId), 'project')
  }

  resolveModule(packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>, moduleName: string): string {
    const project = this.projectDirectory(packageId)
    const require = createRequire(path.join(project, 'package.json'))
    return pathToFileURL(require.resolve(moduleName)).href
  }

  async readHostUiClient(entryId: ReturnType<typeof DshPluginEntryIdSchema.parse>): Promise<{
    readonly source: string
    readonly css?: string
    readonly metadata: DshNxtHostUi
    readonly packageDigest: string
  }> {
    const entry = this.#repository.getDshPluginEntry(entryId)
    if (!entry) throw new Error('DSH 插件入口不存在。')
    const packageRecord = this.#repository.getDshPluginPackage(entry.packageId)
    if (!packageRecord) throw new Error('DSH 插件包不存在。')
    const manifest = packageManifestSchema.parse(packageRecord.manifest)
    const metadata = manifest.nekroNxt?.hostUi
    if (!metadata || metadata.entryKey !== entry.entryKey) throw new Error('此 DSH 入口没有声明 NXT 页面。')
    const packageRoot = await realpath(
      path.join(this.projectDirectory(entry.packageId), 'node_modules', packageRecord.packageName),
    )
    const clientPath = path.resolve(packageRoot, metadata.client)
    assertInside(packageRoot, clientPath)
    const info = await stat(clientPath)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('DSH NXT Client 必须是 1 MiB 内的普通文件。')
    const css =
      metadata.css === undefined
        ? undefined
        : await readFile(this.#resolveHostUiResource(packageRoot, metadata.css, 128 * 1024), 'utf8')
    return {
      source: await readFile(clientPath, 'utf8'),
      ...(css === undefined ? {} : { css }),
      metadata,
      packageDigest: packageRecord.packageDigest,
    }
  }

  async readHostUiSvg(entryId: ReturnType<typeof DshPluginEntryIdSchema.parse>, digest: string): Promise<string> {
    const client = await this.readHostUiClient(entryId)
    const icon = client.metadata.pages
      .map(({ icon }) => icon)
      .find((candidate) => candidate.kind === 'svg' && candidate.sha256 === digest)
    if (!icon || icon.kind !== 'svg') throw new Error('DSH 页面图标不存在。')
    const entry = this.#repository.getDshPluginEntry(entryId)
    const packageRecord = entry ? this.#repository.getDshPluginPackage(entry.packageId) : undefined
    if (!entry || !packageRecord) throw new Error('DSH 插件入口不存在。')
    const packageRoot = await realpath(
      path.join(this.projectDirectory(entry.packageId), 'node_modules', packageRecord.packageName),
    )
    const source = await readFile(this.#resolveHostUiResource(packageRoot, icon.path, 32 * 1024), 'utf8')
    if (createHash('sha256').update(source).digest('hex') !== icon.sha256) throw new Error('DSH 页面图标摘要不一致。')
    validateHostUiSvg(source)
    return source
  }

  #resolveHostUiResource(packageRoot: string, relativePath: string, maxBytes: number): string {
    const resourcePath = path.resolve(packageRoot, relativePath)
    assertInside(packageRoot, resourcePath)
    const info = statSync(resourcePath)
    if (!info.isFile() || info.size > maxBytes) throw new Error('DSH NXT UI 资源文件无效。')
    return resourcePath
  }

  async moveToTrash(packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>): Promise<string> {
    const source = this.packageDirectory(packageId)
    const target = path.join(this.#root, 'plugin-trash', `${packageId}-${Date.now()}`)
    await rename(source, target)
    return target
  }

  async restoreFromTrash(
    packageId: ReturnType<typeof DshPluginPackageIdSchema.parse>,
    trashDirectory: string,
  ): Promise<void> {
    assertInside(path.join(this.#root, 'plugin-trash'), trashDirectory)
    await rename(trashDirectory, this.packageDirectory(packageId))
  }

  async dispose(): Promise<void> {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    const outcomes = await Promise.allSettled(
      pending.map((inspection) => rm(inspection.stagingDirectory, { recursive: true, force: true })),
    )
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'DSH plugin staging cleanup failed.')
  }

  async #inspect(
    source: 'registry' | 'tarball' | 'imported',
    spec: string,
    existingStagingRoot?: string,
    expected?: DshPluginImportExpectation,
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginInstallInspection> {
    await this.initialize()
    await this.#cleanupExpiredInspections()
    const stagingDirectory = existingStagingRoot ?? path.join(this.#root, 'plugin-staging', `inspect-${randomUUID()}`)
    try {
      return await this.#inspectPrepared(source, spec, stagingDirectory, expected, onProgress)
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async #inspectPrepared(
    source: 'registry' | 'tarball' | 'imported',
    spec: string,
    stagingDirectory: string,
    expected?: DshPluginImportExpectation,
    onProgress?: DshPluginInstallProgress,
  ): Promise<DshPluginInstallInspection> {
    const packageId = DshPluginPackageIdSchema.parse(`dsp_${this.#nextUlid()}`)
    const token = randomUUID()
    const projectDirectory = path.join(stagingDirectory, 'project')
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(projectDirectory, 'package.json'),
      JSON.stringify({ name: `nekro-nxt-dsh-plugin-${packageId}`, private: true, version: '0.0.0' }, null, 2) + '\n',
      { mode: 0o600 },
    )
    onProgress?.(
      'download',
      source === 'registry' ? '正在从配置的 npm registry 解析并下载精确版本。' : '正在读取上传包。',
    )
    onProgress?.('dependencies', '正在关闭安装脚本并安装生产依赖。')
    await this.#runPnpm(projectDirectory, [
      'add',
      '--save-prod',
      '--save-exact',
      '--ignore-scripts',
      source === 'registry' ? spec : spec,
    ])
    const projectManifest = z
      .object({ dependencies: z.record(z.string(), z.string()).default({}) })
      .passthrough()
      .parse(JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8')))
    const packageName = Object.keys(projectManifest.dependencies)[0]
    if (!packageName || Object.keys(projectManifest.dependencies).length !== 1) {
      throw new Error('DSH 插件安装项目必须且只能包含一个根包。')
    }
    const packageRoot = await realpath(path.join(projectDirectory, 'node_modules', packageName))
    assertInside(this.#root, packageRoot)
    const manifest = packageManifestSchema.parse(
      JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')),
    )
    if (manifest.name !== packageName) throw new Error('DSH 插件安装后的包身份与依赖记录不一致。')
    const packageDigest = await hashDirectory(packageRoot)
    const lockfile = await readFile(path.join(projectDirectory, 'pnpm-lock.yaml'))
    const lockfileDigest = dependencyLockDigest(lockfile, manifest.name, manifest.version)
    const integrity =
      source === 'registry' ? registryIntegrity(lockfile, manifest.name, manifest.version) : expected?.integrity
    const existing = this.#repository.getDshPluginPackageByIdentity(manifest.name, manifest.version, packageDigest)
    if (existing) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw new Error(`相同 DSH 插件已经安装：${manifest.name}@${manifest.version}`)
    }
    onProgress?.('build-scripts', '正在检查确实被阻止的依赖构建脚本。')
    const { blockedBuilds, buildAllowKeys } = await this.#blockedBuilds(projectDirectory)
    onProgress?.('validation', '正在校验 npm 身份、Bundle 入口和内容摘要。')
    const entries = this.#inspectEntries(packageRoot, manifest)
    const projectRequire = createRequire(path.join(projectDirectory, 'package.json'))
    for (const entry of entries) {
      let resolved: string
      try {
        resolved = await realpath(projectRequire.resolve(entry.moduleName))
      } catch (error) {
        throw new Error(`DSH 插件入口无法解析：${entry.moduleName}（${messageOf(error)}）`)
      }
      assertInside(this.#root, resolved)
      if (!(await stat(resolved)).isFile()) throw new Error(`DSH 插件入口不是普通文件：${entry.moduleName}`)
    }
    const hostUi = manifest.nekroNxt?.hostUi
    if (hostUi) {
      if (!entries.some(({ entryKey }) => entryKey === hostUi.entryKey)) {
        throw new Error(`nekroNxt.hostUi 指向不存在的 DSH 入口：${hostUi.entryKey}`)
      }
      const clientPath = path.resolve(packageRoot, hostUi.client)
      assertInside(packageRoot, clientPath)
      const clientInfo = await stat(clientPath)
      if (!clientInfo.isFile() || clientInfo.size > 1024 * 1024) {
        throw new Error('DSH NXT Client 必须是 1 MiB 内的普通文件。')
      }
      const source = await readFile(clientPath, 'utf8')
      if (/\bimport\s*(?:\(|[{'"*])|\bexport\s+[^;]*\sfrom\s*['"]/u.test(source)) {
        throw new Error('DSH NXT Client 必须是自包含 ESM，不能在浏览器中继续导入包内或外部模块。')
      }
      if (hostUi.css) {
        const cssPath = path.resolve(packageRoot, hostUi.css)
        assertInside(packageRoot, cssPath)
        const cssInfo = await stat(cssPath)
        if (!cssInfo.isFile() || cssInfo.size > 128 * 1024) throw new Error('DSH NXT CSS 必须是 128 KiB 内的普通文件。')
        validateHostUiCss(await readFile(cssPath, 'utf8'))
      }
      for (const page of hostUi.pages) {
        if (page.icon.kind !== 'svg') continue
        const svgPath = path.resolve(packageRoot, page.icon.path)
        assertInside(packageRoot, svgPath)
        const svgInfo = await stat(svgPath)
        if (!svgInfo.isFile() || svgInfo.size > 32 * 1024) throw new Error('DSH NXT SVG 必须是 32 KiB 内的普通文件。')
        const svg = await readFile(svgPath, 'utf8')
        if (createHash('sha256').update(svg).digest('hex') !== page.icon.sha256) {
          throw new Error(`DSH NXT SVG 摘要不一致：${page.icon.path}`)
        }
        validateHostUiSvg(svg)
      }
    }
    if (expected) {
      if (manifest.name !== expected.packageName || manifest.version !== expected.packageVersion) {
        throw new Error('DSH 导入包的 npm 身份与分享清单不一致。')
      }
      if (packageDigest !== expected.packageDigest) throw new Error('DSH 导入包内容摘要与分享清单不一致。')
      if (lockfileDigest !== expected.lockfileDigest) throw new Error('DSH 导入包依赖锁摘要与分享清单不一致。')
      const actualEntries = entries.map(({ entryKey, moduleName }) => ({ entryKey, moduleName }))
      if (
        canonicalJson(JsonValueSchema.parse(actualEntries)) !== canonicalJson(JsonValueSchema.parse(expected.entries))
      ) {
        throw new Error('DSH 导入包入口清单与实际 Bundle 展开结果不一致。')
      }
    }
    const pending: PendingInspection = {
      token,
      expiresAt: this.#timestamp() + INSPECTION_TTL_MS,
      packageId,
      source,
      stagingDirectory,
      projectDirectory,
      manifest,
      packageDigest,
      lockfileDigest,
      ...(integrity === undefined ? {} : { integrity }),
      blockedBuilds,
      buildAllowKeys,
      entries,
    }
    this.#pending.set(token, pending)
    return {
      token,
      packageName: manifest.name,
      packageVersion: manifest.version,
      packageDigest,
      lockfileDigest,
      blockedBuilds,
      clientUiDetected: manifest.dsh?.client !== undefined,
      ...(hostUi === undefined ? {} : { hostUi }),
      entries: entries.map(({ entryKey, moduleName, suggestedScope }) => ({
        entryKey,
        moduleName,
        suggestedScope,
      })),
    }
  }

  #inspectEntries(
    packageRoot: string,
    manifest: z.output<typeof packageManifestSchema>,
  ): readonly Omit<DshPluginEntryRecord, 'packageId' | 'createdAt'>[] {
    const patchFile = manifest.dsh?.bundle?.patch
    if (!patchFile) {
      return [
        {
          id: DshPluginEntryIdSchema.parse(`dse_${this.#nextUlid()}`),
          entryKey: 'default',
          moduleName: manifest.name,
          suggestedScope: isAgentLikeModule(manifest.name) ? 'agent' : 'host',
          config: {},
        },
      ]
    }
    const patchPath = path.resolve(packageRoot, patchFile)
    assertInside(packageRoot, patchPath)
    const patches = loadOptionalPatches('nekro-nxt', patchPath)
    const entries = composeEntries([patches ?? []])
    if (!entries.length) throw new Error('DSH Bundle 没有产生可安装的插件入口。')
    return entries
      .filter((entry) => !entry.group)
      .map((entry) => ({
        id: DshPluginEntryIdSchema.parse(`dse_${this.#nextUlid()}`),
        entryKey: entry.id,
        moduleName: entry.name,
        suggestedScope: isAgentLikeModule(entry.name) ? 'agent' : 'host',
        config: JsonValueSchema.parse(entry.config ?? {}),
      }))
  }

  async #blockedBuilds(projectDirectory: string): Promise<{
    readonly blockedBuilds: readonly string[]
    readonly buildAllowKeys: Readonly<Record<string, readonly string[]>>
  }> {
    const detected: string[] = []
    const virtualStore = path.join(projectDirectory, 'node_modules', '.pnpm')
    for (const container of await readdir(virtualStore, { withFileTypes: true })) {
      if (!container.isDirectory()) continue
      const modules = path.join(virtualStore, container.name, 'node_modules')
      let names: readonly Dirent[]
      try {
        names = await readdir(modules, { withFileTypes: true })
      } catch {
        continue
      }
      const packageRoots: string[] = []
      for (const name of names) {
        if (!name.isDirectory() && !name.isSymbolicLink()) continue
        if (!name.name.startsWith('@')) packageRoots.push(path.join(modules, name.name))
        else {
          const scope = path.join(modules, name.name)
          for (const scoped of await readdir(scope, { withFileTypes: true })) {
            if (scoped.isDirectory() || scoped.isSymbolicLink()) packageRoots.push(path.join(scope, scoped.name))
          }
        }
      }
      for (const packageRoot of packageRoots) {
        try {
          const manifest = z
            .object({
              name: z.string().trim().min(1),
              scripts: z.record(z.string(), z.string()).optional(),
              gypfile: z.boolean().optional(),
            })
            .passthrough()
            .parse(JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')))
          const scripts = manifest.scripts ?? {}
          const lifecycle = ['preinstall', 'install', 'postinstall'].some((name) => scripts[name] !== undefined)
          let bindingGyp = false
          try {
            await readFile(path.join(packageRoot, 'binding.gyp'))
            bindingGyp = true
          } catch {
            bindingGyp = false
          }
          if (lifecycle || manifest.gypfile === true || bindingGyp) detected.push(manifest.name)
        } catch {
          // A malformed package manifest is rejected later when it is the root package.
        }
      }
    }
    const staticNames = [...new Set(detected)].sort()
    if (staticNames.length === 0) return { blockedBuilds: [], buildAllowKeys: {} }

    const workspacePath = path.join(projectDirectory, 'pnpm-workspace.yaml')
    await writeFile(
      workspacePath,
      stringifyYaml({ allowBuilds: Object.fromEntries(staticNames.map((name) => [name, false])) }),
      { mode: 0o600 },
    )
    const reportedKeys: string[] = []
    try {
      await this.#runPnpm(projectDirectory, ['install', '--force', '--frozen-lockfile'])
    } catch (error) {
      if (!messageOf(error).includes('ERR_PNPM_IGNORED_BUILDS')) throw error
      const match = /Ignored build scripts:\s*([^\r\n]+)/u.exec(messageOf(error))
      if (match?.[1])
        reportedKeys.push(
          ...match[1]
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        )
    }
    const output = await this.#runPnpm(projectDirectory, ['ignored-builds'])
    const reported = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^@?[\w.-]+(?:\/[\w.-]+)?$/u.test(line) && line !== 'None')
    const workspace = z
      .object({ allowBuilds: z.record(z.string(), z.union([z.boolean(), z.string()])).default({}) })
      .passthrough()
      .parse(parseYaml(await readFile(workspacePath, 'utf8')))
    const reportedNames = new Set(reported)
    for (const key of reportedKeys) {
      const name = staticNames.find((candidate) => key === candidate || key.startsWith(`${candidate}@`))
      if (name) reportedNames.add(name)
    }
    const blockedBuilds = staticNames.filter((name) => reportedNames.has(name))
    const buildAllowKeys = Object.fromEntries(
      blockedBuilds.map((name) => {
        const keys = [...Object.keys(workspace.allowBuilds), ...reportedKeys].filter(
          (key) => key === name || key.startsWith(`${name}@`),
        )
        const exactKeys = keys.filter((key) => key !== name)
        return [name, exactKeys.length ? exactKeys : keys.length ? keys : [name]]
      }),
    )
    return { blockedBuilds, buildAllowKeys }
  }

  async #cleanupExpiredInspections(): Promise<void> {
    const now = this.#timestamp()
    const expired = [...this.#pending.values()].filter(({ expiresAt }) => expiresAt <= now)
    for (const inspection of expired) this.#pending.delete(inspection.token)
    const outcomes = await Promise.allSettled(
      expired.map(({ stagingDirectory }) => rm(stagingDirectory, { recursive: true, force: true })),
    )
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'Expired DSH plugin staging cleanup failed.')
  }

  #runPnpm(projectDirectory: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.#pnpmCli, ...args], {
        cwd: projectDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env['PATH'],
          TMPDIR: process.env['TMPDIR'],
          ELECTRON_RUN_AS_NODE: process.env['ELECTRON_RUN_AS_NODE'],
          HTTPS_PROXY: process.env['HTTPS_PROXY'],
          HTTP_PROXY: process.env['HTTP_PROXY'],
          NO_PROXY: process.env['NO_PROXY'],
          npm_config_registry: process.env['npm_config_registry'],
          npm_config_store_dir: this.#storeDirectory,
        },
      })
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      const append = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_COMMAND_OUTPUT) {
          child.kill('SIGKILL')
          return
        }
        if (kind === 'stdout') stdout += chunk.toString('utf8')
        else stderr += chunk.toString('utf8')
      }
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
      const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (outputBytes > MAX_COMMAND_OUTPUT) {
          reject(new Error('DSH 插件安装日志超过 2 MiB 限制。'))
        } else if (code !== 0) {
          reject(new Error(`pnpm ${args[0] ?? ''} 失败（${signal ?? code}）：${stderr.trim() || stdout.trim()}`))
        } else {
          resolve(stdout)
        }
      })
    })
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
