import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const packageRoot = path.join(root, 'packages')
const errors = []

async function walk(directory) {
  let entries = []
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'lib'].includes(entry.name)) await walk(target)
      continue
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue
    const content = await readFile(target, 'utf8')
    const relative = path.relative(root, target)
    if (/from\s+['"][^'"]+\/src\/(?:internal|private)\//.test(content)) {
      errors.push(`${relative}: 不得跨包导入 src/internal 或 src/private`)
    }
    if (
      /^packages\/(?:core|channel-runtime|extension-runtime)\//.test(relative) &&
      /from\s+['"]electron['"]/.test(content)
    ) {
      errors.push(`${relative}: 共享 Runtime 包不得依赖 Electron`)
    }
  }
}

await walk(packageRoot)

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Workspace boundary check passed.')
}
