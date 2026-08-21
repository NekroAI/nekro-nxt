import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReleaseChannel } from './product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const channel = parseReleaseChannel(args[0])
const platformIndex = args.indexOf('--platform')
const defaultPlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
const platform = platformIndex >= 0 ? args[platformIndex + 1] : defaultPlatform
if (!['mac', 'win', 'linux', 'all'].includes(platform)) {
  throw new Error(`Desktop 构建平台无效：${platform ?? 'undefined'}`)
}

const pnpmCli = process.env['npm_execpath']
if (!pnpmCli) throw new Error('Desktop Release 必须通过 pnpm script 启动。')
const result = spawnSync(
  process.execPath,
  [pnpmCli, '--filter', '@nekro-nxt/desktop', 'dist', '--channel', channel, '--target', platform],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] ?? ''}`,
    },
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
