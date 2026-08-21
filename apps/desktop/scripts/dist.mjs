import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const directoryOnly = args.includes('--dir')
const targetIndex = args.indexOf('--target')
const archIndex = args.indexOf('--arch')
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined
const arch = archIndex >= 0 ? args[archIndex + 1] : undefined

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
const pnpmCli = process.env['npm_execpath']
if (!pnpmCli) throw new Error('Desktop 分发必须通过 pnpm script 启动。')
const runPnpm = (commandArgs) =>
  run(process.execPath, [pnpmCli, '--config.verify-deps-before-run=false', ...commandArgs], appRoot)

runPnpm(['--filter', '@nekro-nxt/web', 'build'])
runPnpm(['--filter', '@nekro-nxt/server...', 'run', 'build'])
runPnpm(['--filter', '@nekro-nxt/desktop', 'build'])
run(process.execPath, ['scripts/prepare-server-runtime.mjs'], appRoot)
run(process.execPath, ['scripts/rebuild-server-runtime.mjs', ...(arch === undefined ? [] : ['--arch', arch])], appRoot)

const builderCli = fileURLToPath(new URL('../node_modules/electron-builder/out/cli/cli.js', import.meta.url))
const builderArgs = ['--config', 'electron-builder.config.mjs', '--publish', 'never']
if (directoryOnly) builderArgs.push('--dir')
if (target !== undefined) builderArgs.push(`--${target}`)
if (arch !== undefined) builderArgs.push(`--${arch}`)
const builderEnvironment = { ...process.env }
delete builderEnvironment['npm_execpath']
delete builderEnvironment['npm_config_user_agent']
run(process.execPath, [builderCli, ...builderArgs], appRoot, builderEnvironment)
