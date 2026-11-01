import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserDataFixture } from '../tests/data-move-fixture.ts'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(desktopRoot, 'package.json'))
const serverEntry = path.resolve(desktopRoot, '..', 'server', 'dist', 'main.mjs')

// Forks the built Server the way Desktop does and records how the child ended. An Electron utility process keeps
// running after its script finishes, so a maintenance command that only returns never exits (#105).
const harness = `
import { app, utilityProcess } from 'electron';
import { writeFileSync } from 'node:fs';
const [entry, database, result] = process.argv.slice(-3);
app.whenReady().then(() => {
  const startedAt = Date.now();
  const child = utilityProcess.fork(entry, ['--check-sqlite', database], { stdio: 'pipe', env: { ...process.env, NEKRO_DATA: process.env.NXT_TEST_DATA } });
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += Buffer.from(chunk).toString('utf8'); });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += Buffer.from(chunk).toString('utf8'); });
  let done = false;
  const finish = (outcome) => { if (done) return; done = true; writeFileSync(result, JSON.stringify({ ...outcome, stdout, stderr, ms: Date.now() - startedAt })); app.exit(0); };
  child.once('exit', (code) => finish({ exited: true, code }));
  setTimeout(() => { child.kill(); finish({ exited: false }); }, 15000);
});
`

test('the built Server exits after checking a database in an Electron utility process', async () => {
  test.skip(!existsSync(serverEntry), 'Build the Server first: pnpm --filter @nekro-nxt/server build')
  test.setTimeout(40_000)
  const { root: temporary, userData } = await createUserDataFixture()
  try {
    const database = path.join(userData, 'data', 'core.sqlite')
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module', main: 'main.mjs' }))
    await writeFile(path.join(temporary, 'main.mjs'), harness)
    const result = path.join(temporary, 'result.json')
    const executable: unknown = require('electron')
    if (typeof executable !== 'string') throw new Error('Electron executable path is unavailable.')
    const env: Record<string, string> = { NXT_TEST_DATA: path.dirname(database) }
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
    await new Promise<void>((resolve, reject) => {
      const electron = spawn(executable, [temporary, serverEntry, database, result], { env, stdio: 'ignore' })
      electron.once('error', reject)
      electron.once('exit', () => resolve())
    })
    const outcome: unknown = JSON.parse(await readFile(result, 'utf8'))
    expect(outcome).toMatchObject({ exited: true, code: 0 })
    expect(outcome).toMatchObject({ stdout: expect.stringContaining('nxt:check-sqlite:passed') })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
