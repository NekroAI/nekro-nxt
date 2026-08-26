import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

const deadline = Date.now() + 60_000
let ready = false
let lastError
try {
  while (Date.now() < deadline) {
    const result = await Promise.race([
      exited.then(({ code, signal }) => ({ kind: 'exit', code, signal })),
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
        if (result.response.ok && body?.status === 'ready' && body?.releaseId === releaseId) {
          ready = true
          break
        }
        lastError = new Error(`就绪响应不匹配：HTTP ${result.response.status} ${result.body}`)
      } catch (error) {
        lastError = error
      }
    } else {
      lastError = result.error
    }
    await delay(200)
  }
  if (!ready) throw new Error('Desktop Server 未能在 60 秒内就绪。', { cause: lastError })
  console.log(`[desktop-runtime] 最终打包目录已通过 Server readiness 验证：${releaseId}`)
} catch (error) {
  const detail = output.join('').trim()
  if (detail) console.error(detail)
  throw error
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await Promise.race([exited.catch(() => undefined), delay(5_000)])
  await rm(dataRoot, { recursive: true, force: true })
}
