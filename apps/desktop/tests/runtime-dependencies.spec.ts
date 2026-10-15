import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifySubprocessRuntime } from '../../../scripts/lib/runtime-subprocess-smoke.mjs'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

describe('Desktop runtime dependencies', () => {
  it('executes the real DSH subprocess service with the Desktop Electron executable', async () => {
    const require = createRequire(new URL('../package.json', import.meta.url))
    const electron: unknown = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron executable path is unavailable.')
    await verifySubprocessRuntime(electron, fileURLToPath(new URL('../../server', import.meta.url)))
  }, 35_000)

  it('rejects a final packaged tree without DSH before starting its Server', async () => {
    const resources = await mkdtemp(path.join(tmpdir(), 'nxt-final-runtime-'))
    try {
      await mkdir(path.join(resources, 'server-runtime', 'dist'), { recursive: true })
      await mkdir(path.join(resources, 'web-dist'))
      await writeFile(path.join(resources, 'web-dist', 'index.html'), '<!doctype html>')
      await writeFile(
        path.join(resources, 'server-runtime', 'dist', 'main.mjs'),
        'throw new Error("server-must-not-start")',
      )
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/verify-packaged-server-runtime.mjs', import.meta.url)),
          '--executable',
          process.execPath,
          '--resources',
          resources,
        ],
        { encoding: 'utf8', timeout: 12_000 },
      )
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Packaged subprocess smoke failed')
      expect(result.stderr).toContain('stderr (last 8192 bytes)')
      expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND')
      expect(result.stderr).not.toContain('server-must-not-start')
    } finally {
      await rm(resources, { recursive: true, force: true })
    }
  })

  it('pins the approved aged Electron release with the WebContentsView hit-test fix', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const repositoryRoot = path.resolve(desktopRoot, '../..')
    const packageJson: unknown = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'))
    const dependencies = isRecord(packageJson) ? packageJson['devDependencies'] : undefined
    const electron = isRecord(dependencies) ? dependencies['electron'] : undefined
    if (typeof electron !== 'string') throw new Error('Desktop package must declare Electron.')
    expect(electron).toBe('42.9.0')

    const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile).toContain(`specifier: ${electron}`)
    expect(lockfile).toContain(`electron@${electron}:`)

    const workspace = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
    const exclusions = workspace.split('minimumReleaseAgeExclude:')[1]?.split('# Desktop Release')[0] ?? ''
    expect(exclusions).not.toContain('electron@')
  })

  it('materializes a portable Server dependency tree and starts the final packaged runtime', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const repositoryRoot = path.resolve(desktopRoot, '../..')
    const prepareScript = await readFile(path.join(desktopRoot, 'scripts/prepare-server-runtime.mjs'), 'utf8')
    expect(prepareScript).toContain("'--config.node-linker=hoisted'")
    expect(prepareScript).toContain("'--config.package-import-method=copy'")
    expect(prepareScript).toContain("'@deepseek-ai/cosmokit'")

    const verifier = await readFile(path.join(desktopRoot, 'scripts/verify-packaged-server-runtime.mjs'), 'utf8')
    expect(verifier).toContain("ELECTRON_RUN_AS_NODE: '1'")
    expect(verifier).toContain('/health/ready')
    expect(verifier).toContain('/api/settings/notifications')
    expect(verifier).toContain('deviceKeyConfigured')
    expect(verifier).toContain('installManagedPluginSmoke')
    expect(verifier).toContain('verifyRestoredManagedPluginAndRemove')
    expect(verifier).toContain("child.kill('SIGTERM')")
    expect(verifier).toContain("result.signal === 'SIGTERM'")

    const pluginInstaller = await readFile(path.join(repositoryRoot, 'apps/server/src/dsh-plugin-installer.ts'), 'utf8')
    expect(pluginInstaller).toContain("ELECTRON_RUN_AS_NODE: process.env['ELECTRON_RUN_AS_NODE']")

    const desktopMain = await readFile(path.join(desktopRoot, 'src/main.ts'), 'utf8')
    expect(desktopMain).toContain("ELECTRON_RUN_AS_NODE: '1'")

    for (const channel of ['stable', 'preview']) {
      const previousChannel = process.env['NEKRO_DESKTOP_CHANNEL']
      process.env['NEKRO_DESKTOP_CHANNEL'] = channel
      try {
        const configUrl = new URL(`../electron-builder.config.mjs?runtime-smoke-${channel}`, import.meta.url).href
        const configModule: unknown = await import(configUrl)
        if (
          typeof configModule !== 'object' ||
          configModule === null ||
          !('default' in configModule) ||
          !('verifyPackagedServerRuntime' in configModule)
        ) {
          throw new TypeError('electron-builder 配置缺少默认导出')
        }
        const config = configModule.default
        if (typeof config !== 'object' || config === null || !('afterPack' in config)) {
          throw new TypeError('electron-builder 配置缺少 afterPack 验证')
        }
        expect(config.afterPack).toBe(configModule.verifyPackagedServerRuntime)
      } finally {
        if (previousChannel === undefined) delete process.env['NEKRO_DESKTOP_CHANNEL']
        else process.env['NEKRO_DESKTOP_CHANNEL'] = previousChannel
      }
    }
  })
})
