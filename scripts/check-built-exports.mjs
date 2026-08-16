import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packages = [
  'adapter-sdk',
  'adapter-web',
  'channel-runtime',
  'client-migrations',
  'contracts',
  'core',
  'dsh-compat',
  'extension-sdk',
  'extension-runtime',
  'storage-sqlite',
  'test-harness',
]

for (const directory of packages) {
  const packageRoot = path.join(process.cwd(), 'packages', directory)
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const target = manifest.exports?.['.']?.import
  if (typeof target !== 'string') throw new Error(`${directory} has no ESM import export.`)
  await import(pathToFileURL(path.resolve(packageRoot, target)).href)
}

console.log(`Built export check passed (${packages.length} packages).`)
