import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = path.resolve(appRoot, '../..')
const destination = path.join(appRoot, 'dist', 'runtime')
const pnpmCli = process.env['npm_execpath']
if (!pnpmCli) throw new Error('Server 运行依赖部署必须通过 pnpm script 启动。')

await rm(destination, { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  [pnpmCli, '--filter', '@nekro-nxt/server', 'deploy', '--prod', '--legacy', destination],
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
