import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifySubprocessRuntime, verifySubprocessRuntimeFiles } from '../lib/runtime-subprocess-smoke.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-subprocess-smoke-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function file(root, relative, content = '') {
  const filename = path.join(root, relative)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, content)
}

// Broken runtime packages exercise the real probe process and its failure boundary;
// the successful service test below uses the installed, unmodified DSH packages.
async function brokenRuntime(t, localSource, runnerSource = '') {
  const root = await fixture(t)
  await file(
    root,
    'node_modules/@deepseek-ai/cordis/package.json',
    JSON.stringify({ type: 'module', exports: './index.js' }),
  )
  await file(
    root,
    'node_modules/@deepseek-ai/cordis/index.js',
    `
export class Context {
  fiber = { dispose: async () => {} }
  async plugin(Plugin) { this.subprocess = new Plugin() }
}`,
  )
  await file(
    root,
    'node_modules/@deepseek-ai/dsh-subprocess-local/package.json',
    JSON.stringify({
      type: 'module',
      exports: { '.': './index.js', './runner': './runner.js' },
    }),
  )
  await file(root, 'node_modules/@deepseek-ai/dsh-subprocess-local/index.js', localSource)
  await file(root, 'node_modules/@deepseek-ai/dsh-subprocess-local/runner.js', runnerSource)
  await file(
    root,
    'node_modules/@deepseek-ai/dsh-win32-process/package.json',
    JSON.stringify({ type: 'module', exports: './index.js' }),
  )
  await file(
    root,
    'node_modules/@deepseek-ai/dsh-win32-process/index.js',
    `
export const loadWin32ProcessBindings = () => ({})
export const probeCurrentTokenJobSupport = () => {}
`,
  )
  return root
}

function resultFixture({ exitCode = 0, empty = true, windows = false } = {}) {
  return `
${windows ? "Object.defineProperty(process, 'platform', { value: 'win32' })" : ''}
export default class {
  spawn() {
    return {
      done: Promise.resolve({ exitCode: ${exitCode}, signal: null }),
      waitForExit: async () => ${empty},
      collected: {
        stdout: { readFrom: () => ({ lossy: false, text: JSON.stringify({marker: 'nxt-subprocess-smoke', ppid: process.pid}) }) },
        stderr: { readFrom: () => ({ lossy: false, text: 'nxt-subprocess-stderr' }) },
      },
    }
  }
}
`
}

test('executes a real LocalSubprocessRuntime command and waits for the managed range', async () => {
  const runtime = fileURLToPath(new URL('../../apps/server', import.meta.url))
  await verifySubprocessRuntime(process.execPath, runtime)
})

test('reports runner-only missing imports before their stderr can be lost', async (t) => {
  const root = await brokenRuntime(t, 'export default class {}', 'import "missing-runner-dependency-fixture"')
  await assert.rejects(
    verifySubprocessRuntime(process.execPath, root),
    /stderr \(last 8192 bytes\):[\s\S]*missing-runner-dependency-fixture/u,
  )
})

test('rejects silent exit zero before the command has actually completed', async (t) => {
  const root = await brokenRuntime(t, 'process.exit(0); export default class {}')
  await assert.rejects(verifySubprocessRuntime(process.execPath, root), /smoke failed \(code 0/u)
})

test('drains oversized startup diagnostics but retains only bounded tails', async (t) => {
  const root = await brokenRuntime(
    t,
    `
import { writeSync } from 'node:fs'
// writeSync on a full pipe is partial or EAGAIN; loop so the tail markers are really delivered.
const writeAll = (fd, text) => {
  const bytes = Buffer.from(text)
  let offset = 0
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset)
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error
    }
  }
}
writeAll(1, 'stdout-head' + 'o'.repeat(100000) + 'stdout-tail')
writeAll(2, 'stderr-head' + 'e'.repeat(100000) + 'stderr-tail')
process.exit(7)
export default class {}
`,
  )
  await assert.rejects(verifySubprocessRuntime(process.execPath, root), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /code 7/u)
    assert.match(error.message, /stderr-tail/u)
    assert.match(error.message, /stdout-tail/u)
    assert.doesNotMatch(error.message, /stderr-head|stdout-head/u)
    assert.ok(error.message.length < 17000)
    return true
  })
})

test('bounds a hung startup and waits for its process to close', async (t) => {
  const root = await brokenRuntime(
    t,
    'setInterval(() => {}, 1000); await new Promise(() => {}); export default class {}',
  )
  await assert.rejects(verifySubprocessRuntime(process.execPath, root, { timeoutMs: 1000 }), /timeout/u)
})

test('reports executable launch failures', async (t) => {
  const root = await fixture(t)
  await assert.rejects(verifySubprocessRuntime(path.join(root, 'missing-executable'), root), /ENOENT/u)
})

test('rejects target failure and includes its stderr', async (t) => {
  const root = await brokenRuntime(t, resultFixture({ exitCode: 9 }))
  await assert.rejects(
    verifySubprocessRuntime(process.execPath, root),
    /Target stderr \(tail\): nxt-subprocess-stderr/u,
  )
})

test('rejects success before the managed range becomes empty', async (t) => {
  const root = await brokenRuntime(t, resultFixture({ empty: false }))
  await assert.rejects(verifySubprocessRuntime(process.execPath, root), /Managed range did not become empty/u)
})

test('rejects Windows fallback even when the command succeeds', async (t) => {
  const root = await brokenRuntime(t, resultFixture({ windows: true }))
  await assert.rejects(verifySubprocessRuntime(process.execPath, root), /Windows Job runner was bypassed/u)
})

test('requires every Windows runner entry and the actual native binary', async (t) => {
  const root = await fixture(t)
  const required = [
    '@deepseek-ai/dsh-subprocess-local/package.json',
    '@deepseek-ai/dsh-subprocess-local/lib/index.js',
    '@deepseek-ai/dsh-subprocess-local/lib/runner.js',
    '@deepseek-ai/dsh-win32-process/package.json',
    '@deepseek-ai/dsh-win32-process/lib/index.js',
    'koffi/package.json',
    'koffi/index.cjs',
    '@koromix/koffi-win32-x64/package.json',
    '@koromix/koffi-win32-x64/index.js',
    '@koromix/koffi-win32-x64/win32_x64/koffi.node',
  ]
  for (const relative of required) await file(root, `node_modules/${relative}`)
  await verifySubprocessRuntimeFiles(root, 'win')
  for (const relative of required) {
    await rm(path.join(root, 'node_modules', relative))
    await assert.rejects(verifySubprocessRuntimeFiles(root, 'win'), (error) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(path.join(...relative.split('/'))), error.message)
      return true
    })
    await file(root, `node_modules/${relative}`)
  }
})
