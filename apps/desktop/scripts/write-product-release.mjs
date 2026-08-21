import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from '../../../scripts/product-release.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = path.resolve(appRoot, '../..')
const release = await readProductRelease(repositoryRoot)
await mkdir(path.join(appRoot, 'dist'), { recursive: true })
await writeFile(path.join(appRoot, 'dist', 'product-release.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8')
await writeFile(
  path.join(appRoot, 'dist', 'package.json'),
  `${JSON.stringify(
    {
      name: 'nekro-nxt-desktop-runtime',
      version: release.version,
      private: true,
      type: 'module',
      main: 'main.mjs',
      description: 'NekroNxt atomic Desktop product release',
      author: 'NekroAI',
    },
    null,
    2,
  )}\n`,
  'utf8',
)
