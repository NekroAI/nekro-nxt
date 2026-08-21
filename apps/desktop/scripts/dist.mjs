import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const target = option('--target')
const channel = option('--channel')
if (!['mac', 'win', 'linux', 'all'].includes(target)) throw new Error(`Desktop target 无效：${target ?? 'undefined'}`)
if (channel !== 'preview' && channel !== 'stable') throw new Error(`Desktop channel 无效：${channel ?? 'undefined'}`)

const run = (command, commandArgs, cwd, environment = process.env) => {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...environment,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${environment['PATH'] ?? ''}`,
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = path.resolve(appRoot, '../..')
const pnpmCli = process.env['npm_execpath']
if (!pnpmCli) throw new Error('Desktop 分发必须通过 pnpm script 启动。')
const buildEnvironment = { ...process.env, CI: 'true', NEKRO_DESKTOP_CHANNEL: channel }
const runPnpm = (commandArgs) =>
  run(process.execPath, [pnpmCli, '--config.verify-deps-before-run=false', ...commandArgs], appRoot, buildEnvironment)

const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' })
if (gitStatus.status !== 0 || gitStatus.stdout.trim() !== '') {
  throw new Error('Desktop Release 构建要求 Git worktree 干净，确保版本与 receipt 对应准确源码。')
}
if ((target === 'mac' || target === 'all') && process.platform !== 'darwin') {
  throw new Error('macOS Universal DMG 必须在 macOS 上构建；--target all 因此也必须从 macOS 启动。')
}

runPnpm(['--filter', '@nekro-nxt/web', 'build'])
runPnpm(['--filter', '@nekro-nxt/server...', 'run', 'build'])
runPnpm(['--filter', '@nekro-nxt/desktop', 'build'])
const builderCli = fileURLToPath(new URL('../node_modules/electron-builder/out/cli/cli.js', import.meta.url))
const builderEnvironment = { ...buildEnvironment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
delete builderEnvironment['npm_execpath']
delete builderEnvironment['npm_config_user_agent']

const packageLocally = (platform) => {
  const architecture = platform === 'mac' ? 'universal' : 'x64'
  run(
    process.execPath,
    [builderCli, '--config', 'electron-builder.config.mjs', `--${platform}`, `--${architecture}`, '--publish', 'never'],
    appRoot,
    builderEnvironment,
  )
}

const packageWindowsWithDocker = () => {
  run(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-e',
      `NEKRO_DESKTOP_CHANNEL=${channel}`,
      '-e',
      'CSC_IDENTITY_AUTO_DISCOVERY=false',
      '-v',
      `${repositoryRoot}:/project`,
      '-w',
      '/project/apps/desktop',
      'electronuserland/builder:wine',
      'npx',
      '--yes',
      'electron-builder@26.8.1',
      '--config',
      'electron-builder.config.mjs',
      '--win',
      '--x64',
      '--publish',
      'never',
    ],
    appRoot,
    builderEnvironment,
  )
}

const prepareRuntime = (platform) => {
  if (platform !== 'linux' || process.platform === 'linux') {
    run(process.execPath, ['scripts/prepare-server-runtime.mjs', '--platform', platform], appRoot, buildEnvironment)
    return
  }
  run(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-e',
      'CI=true',
      '-e',
      'PNPM_CONFIG_STORE_DIR=/tmp/nekro-nxt-pnpm-store',
      '-v',
      `${repositoryRoot}:/project`,
      '-w',
      '/project/apps/desktop',
      'node:22-bookworm',
      'bash',
      '-lc',
      'corepack enable && node scripts/prepare-server-runtime.mjs --platform linux',
    ],
    appRoot,
    builderEnvironment,
  )
}

const platforms = target === 'all' ? ['mac', 'win', 'linux'] : [target]
for (const platform of platforms) {
  prepareRuntime(platform)
  if (platform === 'win' && process.platform !== 'win32') packageWindowsWithDocker()
  else packageLocally(platform)
  run(
    process.execPath,
    ['scripts/write-artifact-receipt.mjs', '--channel', channel, '--platform', platform],
    appRoot,
    buildEnvironment,
  )
}
