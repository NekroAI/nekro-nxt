import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTarball } from 'tar'

const PACKAGE_NAME = '@example/nxt-artifact-managed-plugin-smoke'

const requestJson = async (origin, pathname, init = {}) => {
  const response = await globalThis.fetch(`${origin}${pathname}`, {
    ...init,
    signal: globalThis.AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} 失败：HTTP ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

const createFixtureTarball = async (workingDirectory) => {
  const root = await mkdtemp(path.join(workingDirectory, 'managed-plugin-smoke-'))
  const source = path.join(root, 'package')
  const tarball = path.join(root, 'package.tgz')
  await mkdir(source, { recursive: true })
  await writeFile(
    path.join(source, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0', type: 'module', exports: './index.js' }, null, 2)}\n`,
  )
  await writeFile(
    path.join(source, 'index.js'),
    `export default function artifactManagedPlugin(context) {
  context.effect(() => () => undefined, 'artifact managed plugin smoke')
}
`,
  )
  await createTarball({ cwd: source, file: tarball, gzip: true, prefix: 'package/' }, ['package.json', 'index.js'])
  return { root, content: await readFile(tarball) }
}

const installedCatalogEntry = async (origin, packageId) => {
  const catalog = await requestJson(origin, '/api/dsh/plugins')
  const entry = catalog?.plugins?.find((candidate) => candidate.packageId === packageId)
  if (!entry) throw new Error(`受管 DSH 插件没有出现在目录：${packageId}`)
  return entry
}

export const installManagedPluginSmoke = async (origin, workingDirectory = os.tmpdir()) => {
  const fixture = await createFixtureTarball(workingDirectory)
  try {
    const inspection = await requestJson(origin, '/api/dsh/plugin-installs/inspect-tarball', {
      method: 'POST',
      body: fixture.content,
    })
    if (inspection.packageName !== PACKAGE_NAME || inspection.blockedBuilds?.length !== 0) {
      throw new Error(`受管 DSH 插件检查结果不匹配：${JSON.stringify(inspection)}`)
    }
    const committed = await requestJson(origin, '/api/dsh/plugin-installs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: inspection.token, approvedBuilds: [] }),
    })
    const installed = await installedCatalogEntry(origin, committed.packageId)
    const entry = installed.entries?.[0]
    if (!entry?.id) throw new Error('受管 DSH 插件没有可启用入口。')
    await requestJson(origin, `/api/dsh/plugin-entries/${encodeURIComponent(entry.id)}/activation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'host', config: {} }),
    })
    return {
      format: 'nxt.managed-plugin-artifact-smoke',
      version: 1,
      packageId: committed.packageId,
      entryId: entry.id,
      packageDigest: createHash('sha256').update(fixture.content).digest('hex'),
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}

export const verifyRestoredManagedPluginAndRemove = async (origin, state) => {
  if (state?.format !== 'nxt.managed-plugin-artifact-smoke' || state.version !== 1) {
    throw new Error('受管 DSH 插件制品验证状态无效。')
  }
  const installed = await installedCatalogEntry(origin, state.packageId)
  const entry = installed.entries?.find((candidate) => candidate.id === state.entryId)
  const activation = entry?.activations?.find((candidate) => candidate.targetKey === 'host')
  if (activation?.diagnostic?.status !== 'active') {
    throw new Error(`受管 DSH 插件重启恢复失败：${JSON.stringify(activation)}`)
  }
  await requestJson(origin, `/api/dsh/plugin-entries/${encodeURIComponent(state.entryId)}/activation`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetKey: 'host' }),
  })
  await requestJson(origin, `/api/dsh/plugin-installs/${encodeURIComponent(state.packageId)}`, { method: 'DELETE' })
  const catalog = await requestJson(origin, '/api/dsh/plugins')
  if (catalog?.plugins?.some((candidate) => candidate.packageId === state.packageId)) {
    throw new Error('受管 DSH 插件移除后仍出现在目录。')
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntryPoint) {
  const [command, origin, statePath] = process.argv.slice(2)
  if (!origin || !statePath || !['install', 'verify-remove'].includes(command)) {
    throw new Error('用法：managed-plugin-smoke <install|verify-remove> <origin> <state.json>')
  }
  if (command === 'install') {
    const state = await installManagedPluginSmoke(origin, path.dirname(path.resolve(statePath)))
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } else {
    await verifyRestoredManagedPluginAndRemove(origin, JSON.parse(await readFile(statePath, 'utf8')))
  }
}
