import { spawnSync } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = path.resolve(appRoot, '../..')
const destination = path.join(appRoot, 'dist', 'runtime')
const args = process.argv.slice(2)
const platformIndex = args.indexOf('--platform')
const targetPlatform = platformIndex >= 0 ? args[platformIndex + 1] : undefined
if (!['mac', 'win', 'linux'].includes(targetPlatform)) {
  throw new Error(`Server runtime 目标平台无效：${targetPlatform ?? 'undefined'}`)
}
if (targetPlatform === 'linux' && (process.platform !== 'linux' || process.arch !== 'x64')) {
  throw new Error('Linux x64 Server runtime 必须在 Linux x64 环境准备。')
}
const pnpmCli = process.env['npm_execpath']

await rm(destination, { recursive: true, force: true })
const result = spawnSync(
  pnpmCli ? process.execPath : 'pnpm',
  [...(pnpmCli ? [pnpmCli] : []), '--filter', '@nekro-nxt/server', 'deploy', '--prod', '--legacy', destination],
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

const virtualStore = path.join(destination, 'node_modules', '.pnpm')
const entries = await readdir(virtualStore)
// legacy deploy 会为 workspace 根包留下一个指回 apps/server 的 hoist 链接。
// Server 运行时不消费自身包名；保留该越界链接会让打包后的 Universal 临时目录失去目标。
await rm(path.join(virtualStore, 'node_modules', '@nekro-nxt', 'server'), { force: true })
const findPackageDirectory = (packagePrefix, packagePath) => {
  const entry = entries.find((candidate) => candidate.startsWith(`${packagePrefix}@`))
  if (!entry) throw new Error(`Server runtime 缺少 ${packagePrefix}。`)
  return path.join(virtualStore, entry, 'node_modules', ...packagePath.split('/'))
}
const requireFile = async (filename) => {
  const entry = await stat(filename).catch(() => undefined)
  if (!entry?.isFile()) throw new Error(`Server runtime 缺少跨平台预编译文件：${filename}`)
}

const nodePtyRoot = findPackageDirectory('node-pty', 'node-pty')
const nodePtyPrebuilds =
  targetPlatform === 'mac' ? ['darwin-arm64', 'darwin-x64'] : targetPlatform === 'win' ? ['win32-x64'] : []
if (targetPlatform === 'linux') {
  await requireFile(path.join(nodePtyRoot, 'build', 'Release', 'pty.node'))
} else {
  // node-pty 优先读取 build/Release。部署时生成的宿主二进制会遮蔽包内 N-API
  // prebuild，必须移除，才能让目标平台选择正确文件。
  await rm(path.join(nodePtyRoot, 'build'), { recursive: true, force: true })
}
for (const platformArch of nodePtyPrebuilds) {
  await requireFile(path.join(nodePtyRoot, 'prebuilds', platformArch, 'pty.node'))
}

const betterSqliteRoot = findPackageDirectory('better-sqlite3', 'better-sqlite3')
const targetArchitectures =
  targetPlatform === 'mac' ? ['darwin-arm64', 'darwin-x64'] : targetPlatform === 'win' ? ['win32-x64'] : ['linux-x64']
for (const platformArch of targetArchitectures) {
  await requireFile(path.join(betterSqliteRoot, 'prebuilds', `${platformArch}.node`))
}

const optionalPackagePrefixes =
  targetPlatform === 'mac'
    ? ['@img+sharp-darwin-arm64', '@img+sharp-darwin-x64', '@koromix+koffi-darwin-arm64', '@koromix+koffi-darwin-x64']
    : targetPlatform === 'win'
      ? ['@img+sharp-win32-x64', '@koromix+koffi-win32-x64']
      : ['@img+sharp-linux-x64', '@img+sharp-libvips-linux-x64', '@koromix+koffi-linux-x64']
for (const packagePrefix of optionalPackagePrefixes) {
  if (!entries.some((candidate) => candidate.startsWith(`${packagePrefix}@`))) {
    throw new Error(`Server runtime 缺少跨平台可选依赖：${packagePrefix}`)
  }
}
