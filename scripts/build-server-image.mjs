import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease } from './product-release.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const release = await readProductRelease(repositoryRoot)
const image = process.env['NEKRO_IMAGE'] ?? `nekro-nxt:${release.version}`
const result = spawnSync(
  'docker',
  ['build', '--build-arg', `NEKRO_RELEASE_ID=${release.releaseId}`, '--tag', image, '.'],
  { cwd: repositoryRoot, stdio: 'inherit' },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
