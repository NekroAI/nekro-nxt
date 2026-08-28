import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  installManagedPluginSmoke,
  verifyRestoredManagedPluginAndRemove,
} from '../../../scripts/lib/managed-plugin-smoke.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const executable = option('--executable')
const resources = option('--resources')
const releaseId = option('--release-id') ?? 'desktop-runtime-smoke'
if (!executable || !resources) {
  throw new Error('用法：verify-packaged-server-runtime --executable <path> --resources <path> [--release-id <id>]')
}

const requireFile = async (filename, label) => {
  const entry = await stat(filename).catch(() => undefined)
  if (!entry?.isFile()) throw new Error(`${label}不存在：${filename}`)
}

const serverEntryPath = path.join(resources, 'server-runtime', 'dist', 'main.mjs')
const distIndexPath = path.join(resources, 'web-dist', 'index.html')
await requireFile(executable, 'Server runtime 验证使用的 Node 可执行文件')
await requireFile(serverEntryPath, 'Desktop Server 入口')
await requireFile(distIndexPath, 'Desktop Web 入口')
const serverEntry = await realpath(serverEntryPath)
const distIndex = await realpath(distIndexPath)

const reservePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法为 Desktop runtime 验证分配端口。')))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })

const port = await reservePort()
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-desktop-runtime-'))
const output = []
const appendOutput = (chunk) => {
  output.push(String(chunk))
  while (output.join('').length > 32_000) output.shift()
}
const environment = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  NEKRO_DATA: dataRoot,
  NEKRO_DIST_INDEX: distIndex,
  NEKRO_HOST: '127.0.0.1',
  NEKRO_PORT: String(port),
  NEKRO_RELEASE_ID: releaseId,
  NEKRO_LLM_PROVIDERS: '',
}
delete environment['NEKRO_MANAGEMENT_KEY']
delete environment['NEKRO_DEVELOPMENT_WORKSPACE_ROOT']

const launch = () => {
  const child = spawn(executable, [serverEntry], {
    cwd: resources,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, exited }
}

const waitUntilReady = async (running) => {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    const result = await Promise.race([
      running.exited.then(({ code, signal }) => ({ kind: 'exit', code, signal })),
      globalThis
        .fetch(`http://127.0.0.1:${port}/health/ready`, { signal: globalThis.AbortSignal.timeout(2_000) })
        .then(async (response) => ({ kind: 'response', response, body: await response.text() }))
        .catch((error) => ({ kind: 'request-error', error })),
    ])
    if (result.kind === 'exit') {
      throw new Error(`Desktop Server 在就绪前退出（code ${result.code}, signal ${result.signal ?? 'none'}）。`)
    }
    if (result.kind === 'response') {
      try {
        const body = JSON.parse(result.body)
        if (result.response.ok && body?.status === 'ready' && body?.releaseId === releaseId) return
        lastError = new Error(`就绪响应不匹配：HTTP ${result.response.status} ${result.body}`)
      } catch (error) {
        lastError = error
      }
    } else {
      lastError = result.error
    }
    await delay(200)
  }
  throw new Error('Desktop Server 未能在 60 秒内就绪。', { cause: lastError })
}

const stop = async (running) => {
  let terminationRequested = false
  if (running.child.exitCode === null && running.child.signalCode === null) {
    terminationRequested = running.child.kill('SIGTERM')
  }
  const result = await Promise.race([running.exited, delay(10_000).then(() => ({ timeout: true }))])
  if ('timeout' in result) {
    running.child.kill('SIGKILL')
    throw new Error('Desktop Server 未能在 10 秒内静止关闭。')
  }
  const expectedSignalExit = terminationRequested && result.code === null && result.signal === 'SIGTERM'
  if (result.code !== 0 && !expectedSignalExit) {
    throw new Error(`Desktop Server 关闭失败（code ${result.code}, signal ${result.signal ?? 'none'}）。`)
  }
}

const verifyCredentialPersistence = async () => {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system: { enabled: true },
      bark: {
        enabled: false,
        serverUrl: 'https://push.example.test',
        deviceKey: 'desktop-runtime-credential-smoke',
      },
      events: { 'dynamic-client-approval-requested': true },
    }),
    signal: globalThis.AbortSignal.timeout(5_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`凭据写入验证失败：HTTP ${response.status} ${body}`)
  const settings = JSON.parse(body)
  if (settings?.bark?.deviceKeyConfigured !== true) {
    throw new Error(`凭据写入验证响应不匹配：${body}`)
  }
}
let running = launch()
try {
  await waitUntilReady(running)
  await verifyCredentialPersistence()
  const managedPlugin = await installManagedPluginSmoke(`http://127.0.0.1:${port}`, dataRoot)
  await stop(running)
  running = launch()
  await waitUntilReady(running)
  await verifyRestoredManagedPluginAndRemove(`http://127.0.0.1:${port}`, managedPlugin)
  console.log(
    `[desktop-runtime] 最终打包目录已通过 Server 就绪、凭据持久化与 DSH 插件安装/恢复/关闭/移除验证：${releaseId}`,
  )
} catch (error) {
  const detail = output.join('').trim()
  if (detail) console.error(detail)
  throw error
} finally {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM')
  await Promise.race([running.exited.catch(() => undefined), delay(5_000)])
  await rm(dataRoot, { recursive: true, force: true })
}
