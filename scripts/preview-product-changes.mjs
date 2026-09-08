import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { hasPreviewProductChanges, publishedPreviewCommit } from './lib/preview-changes.mjs'

function run(command, args, allowMissing = false) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404|Not Found/iu.test(result.stderr + result.stdout)) return undefined
    throw new Error(`${command} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}
const repository = process.env.GITHUB_REPOSITORY
if (!repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('Missing GitHub repository.')
const releaseJson = run('gh', ['api', `/repos/${repository}/releases/tags/preview`], true)
const release = releaseJson ? JSON.parse(releaseJson) : undefined
let previous = publishedPreviewCommit(release)
if (!previous && release && !release.draft)
  previous = run('git', ['rev-parse', '--verify', 'refs/tags/preview^{commit}'])
const forced = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
const changed =
  forced ||
  !previous ||
  hasPreviewProductChanges(
    (run('git', ['diff', '--name-only', '-z', previous, 'HEAD']) ?? '').split('\0').filter(Boolean),
  )
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${changed}\n`)
console.log(
  changed
    ? 'Unpublished product changes require Preview.'
    : 'No unpublished product changes; Preview remains unchanged.',
)
