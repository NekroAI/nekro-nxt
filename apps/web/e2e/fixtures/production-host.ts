import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface JourneyServer {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  diagnostics(): string
}

export const reserveJourneyPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法为 Host 恢复旅程分配端口。')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })

export const spawnJourneyServer = (port: number, dataRoot: string): JourneyServer => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'apps/server/dist/main.mjs')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NEKRO_DATA: dataRoot,
      NEKRO_DIST_INDEX: path.join(repositoryRoot, 'apps/web/dist/index.html'),
      NEKRO_HOST: '127.0.0.1',
      NEKRO_LLM_PROVIDERS: '',
      NEKRO_PORT: String(port),
      NEKRO_RELEASE_ID: 'journey-host-restart',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  return { child, exited, diagnostics: () => output }
}

export const waitForJourneyServerReady = async (origin: string, server: JourneyServer): Promise<void> => {
  const deadline = Date.now() + 60_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Host 在就绪前退出。\n${server.diagnostics()}`)
    }
    try {
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1_000) })
      const body: unknown = response.ok ? await response.json() : undefined
      if (isRecord(body) && body['status'] === 'ready' && body['releaseId'] === 'journey-host-restart') return
      lastError = new Error(`Host readiness 返回 ${response.status}。`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Host 未能在产品旅程时限内就绪。\n${server.diagnostics()}`, { cause: lastError })
}

export const stopJourneyServer = async (server: JourneyServer): Promise<void> => {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    await server.exited
    return
  }
  server.child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      server.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Host 未能及时退出。\n${server.diagnostics()}`)), 20_000)
      }),
    ])
  } catch (error) {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL')
    await server.exited.catch(() => undefined)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
