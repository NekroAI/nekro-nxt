import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = process.cwd()

async function waitForOutput(readOutput, expected, timeoutMs = 5_000) {
  const startedAt = Date.now()
  while (!readOutput().includes(expected)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for child output: ${expected}\n${readOutput()}`)
    }
    await wait(25)
  }
}

test('Server dev watch excludes mutable runtime data while retaining workspace rebuilds', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'apps/server/package.json'), 'utf8'))
  const devScript = packageJson.scripts?.dev

  assert.equal(typeof devScript, 'string')
  assert.match(devScript, /tsx watch/u)
  assert.match(devScript, /--exclude ['"]\.\.\/\.\.\/data\/\*\*['"]/u)
  assert.match(devScript, /--include ['"]\.\.\/\.\.\/packages\/\*\/dist\/\*\.mjs['"]/u)
  assert.match(devScript, /src\/main\.ts$/u)
})

test('tsx does not restart when an imported module below the excluded data root is deleted', async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-watch-boundary-'))
  const serverRoot = path.join(fixtureRoot, 'apps/server')
  const runtimeRoot = path.join(fixtureRoot, 'data/extension-cache/revision/build')
  const runtimeModule = path.join(runtimeRoot, 'host.mjs')
  const entryModule = path.join(serverRoot, 'main.mjs')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(serverRoot, { recursive: true })
  await writeFile(runtimeModule, 'export const loaded = true\n', 'utf8')
  await writeFile(
    entryModule,
    `await import(${JSON.stringify(pathToFileURL(runtimeModule).href)})\nconsole.log('watch-boundary-ready')\nsetInterval(() => {}, 1_000)\n`,
    'utf8',
  )

  const tsxCli = path.join(root, 'apps/server/node_modules/tsx/dist/cli.mjs')
  let output = ''
  const child = spawn(
    process.execPath,
    [tsxCli, 'watch', '--clear-screen=false', '--exclude', '../../data/**', entryModule],
    {
      cwd: serverRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  await waitForOutput(() => output, 'watch-boundary-ready')
  await wait(200)
  await unlink(runtimeModule)
  await wait(500)

  assert.equal(child.exitCode, null, output)
  assert.doesNotMatch(output, /\[tsx\].*(?:Restarting|Rerunning)/u)
})
