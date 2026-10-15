import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { lstat, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'

const SUCCESS = '[runtime-subprocess] command and managed range passed'
const OUTPUT_LIMIT = 8 * 1024

/**
 * afterPack calls verifySubprocessRuntime(executable, runtimeRoot) with the final
 * appOutDir executable and resources/server-runtime, before starting the Server.
 * The command checks exit, output and managed-range cleanup, with a 10s command
 * deadline and a 30s outer kill deadline (including import and disposal).
 * Diagnostics retain only the last 8 KiB per stream. Runner imports and Win32
 * bindings are checked before spawning because DSH ignores the runner's own
 * stderr; later failures inside that runner may still lack its private stderr.
 */

/** Verify shipped entry points and target Koffi binaries, without loading foreign binaries. */
export async function verifySubprocessRuntimeFiles(runtimeRoot, platform) {
  const architectures = { mac: ['darwin-arm64', 'darwin-x64'], win: ['win32-x64'], linux: ['linux-x64'] }[platform]
  if (!architectures) throw new Error(`Subprocess runtime platform is invalid: ${platform}`)
  /** @type {Array<[string, string[]]>} */
  const entries = [
    ['@deepseek-ai/dsh-subprocess-local', ['lib/index.js', 'lib/runner.js']],
    ['@deepseek-ai/dsh-win32-process', ['lib/index.js']],
    ['koffi', ['index.cjs']],
  ]
  for (const arch of architectures) {
    entries.push([`@koromix/koffi-${arch}`, ['index.js', `${arch.replace('-', '_')}/koffi.node`]])
  }
  for (const [name, files] of entries) {
    const root = path.join(runtimeRoot, 'node_modules', name)
    const directory = await lstat(root).catch(() => undefined)
    if (!directory?.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(`Server runtime 缺少可搬运的实体依赖目录：${name}`)
    }
    for (const relative of ['package.json', ...files]) {
      const filename = path.join(root, relative)
      if (!(await stat(filename).catch(() => undefined))?.isFile()) {
        throw new Error(`Server runtime 缺少必需文件：${filename}`)
      }
    }
  }
}

// Evaluated from runtimeRoot so every import resolves against the shipped tree.
// In particular, never substitute a system Node for the runner's process.execPath.
const source = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

// The Windows runner discards its own fd 2. Import its public entry here first
// so missing transitive imports are reported on this probe's captured stderr.
const runner = import.meta.resolve('@deepseek-ai/dsh-subprocess-local/runner')
await import(runner)
if (process.platform === 'win32') {
  const requireFromRunner = createRequire(runner)
  const { loadWin32ProcessBindings, probeCurrentTokenJobSupport } = await import(
    pathToFileURL(requireFromRunner.resolve('@deepseek-ai/dsh-win32-process')).href
  )
  probeCurrentTokenJobSupport(loadWin32ProcessBindings())
}

const context = new Context()
let handle
try {
  await context.plugin(LocalSubprocessRuntime)
  const signal = AbortSignal.timeout(10_000)
  handle = context.subprocess.spawn({
    argv: [process.execPath, '-e',
      'process.stdout.write(JSON.stringify({marker:"nxt-subprocess-smoke",ppid:process.ppid}));process.stderr.write("nxt-subprocess-stderr")'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
    graceMs: 1000,
    signal,
  })
  const [outcome, empty] = await Promise.all([handle.done, handle.waitForExit(signal)])
  assert.equal(empty, true, 'Managed range did not become empty')
  assert.equal(signal.aborted, false, 'Subprocess deadline expired')
  assert.deepEqual(outcome, { exitCode: 0, signal: null })
  const stdout = handle.collected.stdout.readFrom(0)
  const stderr = handle.collected.stderr.readFrom(0)
  assert.equal(stdout.lossy, false)
  assert.equal(stderr.lossy, false)
  assert.equal(stderr.text, 'nxt-subprocess-stderr')
  const result = JSON.parse(stdout.text)
  assert.equal(result.marker, 'nxt-subprocess-smoke')
  assert.ok(Number.isSafeInteger(result.ppid) && result.ppid > 0)
  // Ordinary fallback spawns the target directly. A Windows success must have
  // traversed the separate Job runner, rather than silently passing fallback.
  if (process.platform === 'win32') assert.notEqual(result.ppid, process.pid, 'Windows Job runner was bypassed')
} catch (error) {
  const stderr = handle?.collected.stderr?.readFrom(0).text
  if (stderr) console.error('Target stderr (tail):', stderr)
  throw error
} finally {
  await context.fiber.dispose()
}
console.log(${JSON.stringify(SUCCESS)})
`

/** Execute the public subprocess service with the packaged executable and dependencies. */
export async function verifySubprocessRuntime(executable, runtimeRoot, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--input-type=module', '--eval', source], {
      cwd: runtimeRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    const tail = (previous, chunk) => Buffer.concat([previous, chunk.subarray(-OUTPUT_LIMIT)]).subarray(-OUTPUT_LIMIT)
    child.stdout.on('data', (chunk) => {
      stdout = tail(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr, chunk)
    })
    let spawnError
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const output = stdout.toString('utf8')
      if (spawnError || timedOut || code !== 0 || !output.split(/\r?\n/u).includes(SUCCESS)) {
        reject(
          new Error(
            [
              `Packaged subprocess smoke failed (code ${code}, signal ${signal ?? 'none'}${timedOut ? ', timeout' : ''}).`,
              ...(spawnError ? [spawnError.message] : []),
              `stderr (last ${OUTPUT_LIMIT} bytes):\n${stderr.toString('utf8') || '(empty)'}`,
              `stdout (last ${OUTPUT_LIMIT} bytes):\n${output || '(empty)'}`,
            ].join('\n'),
            { cause: spawnError },
          ),
        )
        return
      }
      console.log(SUCCESS)
      resolve(undefined)
    })
  })
}
