import { rebuild } from '@electron/rebuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
const electronVersion = packageJson.devDependencies?.electron
if (typeof electronVersion !== 'string' || electronVersion.length === 0) {
  throw new Error('无法从 Desktop package.json 读取 Electron 版本。')
}

const args = process.argv.slice(2)
const archIndex = args.indexOf('--arch')
const arch = archIndex >= 0 ? args[archIndex + 1] : process.arch
if (arch === undefined || !['arm64', 'ia32', 'x64'].includes(arch)) {
  throw new Error(`不支持的 Electron Server 运行时架构：${arch ?? 'undefined'}`)
}

await rebuild({
  buildPath: path.join(appRoot, 'dist', 'runtime'),
  electronVersion,
  arch,
  force: true,
  onlyModules: ['better-sqlite3', 'node-pty'],
})
