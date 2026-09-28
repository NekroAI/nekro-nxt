import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(desktopRoot, 'package.json'))
const backupId = `runtime-${'b'.repeat(32)}`

// A synthetic Server implements only startup/restore, using the same utilityProcess entry.
// All fixtures and child writes stay inside the temporary userData root.
const serverFixture = `
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
const root = process.env.NEKRO_DATA;
await mkdir(path.join(root, 'backups'), {recursive: true});
if (process.argv[2] === '--restore-upgrade') {
  await writeFile(path.join(root, 'restored.json'), JSON.stringify({args:process.argv.slice(2), executable:process.execPath}));
  process.exit(0);
}
const starts = Number(await readFile(path.join(root, 'starts'), 'utf8').catch(() => '0')) + 1;
await writeFile(path.join(root, 'starts'), String(starts));
const runId = process.env.NEKRO_UPGRADE_RUN_ID;
const status = starts === 1 ? {phase:'backup', progress:{completed:24,total:64,unit:'items'}} : {phase:'recovery', backupId:'${backupId}', errorSummary:'合成升级步骤未通过验证。'};
async function publish() {
  const file = path.join(root, 'backups', 'upgrade-progress.json');
  await writeFile(file+'.tmp', JSON.stringify({format:'nxt.host-upgrade-progress',version:1,releaseId:process.env.NEKRO_RELEASE_ID,runId,pid:process.pid,updatedAt:Date.now(),status}));
  await rename(file+'.tmp', file);
}
await publish();
const timer = setInterval(() => { void publish(); }, 1000);
let cancelling = false;
async function stop() {
  if (cancelling) return;
  cancelling = true;
  clearInterval(timer);
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(path.join(root, 'stopped-'+starts), runId);
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.parentPort?.on('message', ({data}) => { if(data.format==='nxt.host-control' && data.action==='cancel' && data.runId===runId) void stop(); });
`

test('built Desktop safely cancels, retries, diagnoses and restores with its bundled entry', async () => {
  const testInfo = test.info()
  test.setTimeout(45_000)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nxt-desktop-upgrade-'))
  let electron: ElectronApplication | undefined
  try {
    const staged = path.join(temporary, 'desktop')
    await cp(path.join(desktopRoot, 'dist'), staged, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}runtime${path.sep}`),
    })
    await symlink(path.join(desktopRoot, 'node_modules'), path.join(staged, 'node_modules'), 'junction')
    const runtime = path.join(staged, 'runtime', 'dist')
    await mkdir(runtime, { recursive: true })
    await writeFile(path.join(runtime, 'main.mjs'), serverFixture)
    await writeFile(
      path.join(staged, 'product-release.json'),
      JSON.stringify({
        format: 'nxt.product-release',
        channel: 'preview',
        baseVersion: '0.1.0',
        version: '0.1.0-test',
        commit: '1'.repeat(40),
        releaseId: 'desktop-upgrade-fixture',
        dshVersion: '0.1.7-rc.2',
      }),
    )
    const userData = path.join(temporary, 'user-data')
    const executablePath: unknown = require('electron')
    if (typeof executablePath !== 'string') throw new Error('Electron executable path is unavailable.')
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
    electron = await _electron.launch({
      executablePath,
      args: [path.join(staged, 'main.mjs')],
      env: { ...env, NEKRO_DESKTOP_USER_DATA: userData },
    })
    const window = await electron.firstWindow()
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))
    await expect(window.getByRole('heading', { name: '正在备份本地数据' })).toBeVisible()
    await expect(window.getByText('24 项 / 64 项')).toBeVisible()
    await window.screenshot({ path: testInfo.outputPath('upgrade-progress.png') })
    await electron.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
    await window.screenshot({ path: testInfo.outputPath('upgrade-progress-light.png') })
    await window.getByRole('button', { name: '安全取消' }).click()
    await expect(window.getByText('启动已安全停止，可以重试。', { exact: true })).toBeVisible()
    expect(await readFile(path.join(userData, 'data', 'stopped-1'), 'utf8')).not.toBe('')
    await window.getByRole('button', { name: '重试启动' }).click()
    await expect(window.getByRole('heading', { name: '本地服务未能启动' })).toBeVisible()
    await expect(window.getByText('合成升级步骤未通过验证。', { exact: true })).toBeVisible()
    await window.getByText('查看诊断', { exact: true }).click()
    await expect(window.locator('#diagnostics')).toContainText(backupId)
    await window.screenshot({ path: testInfo.outputPath('upgrade-recovery.png') })
    await window.getByRole('button', { name: '恢复升级前备份' }).click()
    await expect(window.getByRole('heading', { name: '备份已恢复' })).toBeVisible()
    await expect(window.getByRole('button', { name: '重试启动' })).toBeHidden()
    await expect(window.getByText('升级前的数据已恢复。请退出当前版本，使用与备份匹配的旧版程序打开。')).toBeVisible()
    const restored: unknown = JSON.parse(await readFile(path.join(userData, 'data', 'restored.json'), 'utf8'))
    expect(restored).toMatchObject({
      args: ['--restore-upgrade', backupId],
      executable: expect.stringContaining(path.join(path.dirname(require.resolve('electron/package.json')), 'dist')),
    })
    expect(await readFile(path.join(userData, 'data', 'starts'), 'utf8')).toBe('2')
    await window.screenshot({ path: testInfo.outputPath('upgrade-restored.png') })
    expect(errors).toEqual([])
    const exited = electron.waitForEvent('close')
    await window.getByRole('button', { name: '退出', exact: true }).click()
    await exited
    electron = undefined
  } finally {
    await electron?.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
