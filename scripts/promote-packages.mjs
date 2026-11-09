#!/usr/bin/env node
// Points the `latest` dist-tag of every shared package at its local version, which must already be on npm (usually
// under `next`). The release workflow runs it after publishing the Release, authenticated by npm trusted publishing;
// `--check` only verifies the versions are on npm; `--reapply` sets `latest` even where it already matches, which is
// how a new trusted publisher gets its first use. A maintainer can still run it by hand (npm asks for 2FA).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localPublicPackages, npmDistTags, npmHasVersion, unpublishedProblem } from './lib/npm-packages.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

async function main() {
  const packages = await localPublicPackages(repositoryRoot)
  const problem = unpublishedProblem(
    packages.map((item) => ({ ...item, published: npmHasVersion(item.name, item.version) })),
  )
  if (problem !== undefined) throw new Error(problem)
  if (process.argv.includes('--check')) {
    console.log('共享包的本地版本都已在 npm 上。')
    return
  }
  for (const { name, version } of packages) {
    if (!process.argv.includes('--reapply') && npmDistTags(name)['latest'] === version) {
      console.log(`${name}@${version} 已是 latest。`)
      continue
    }
    const result = spawnSync('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`没能把 ${name}@${version} 设为 latest。`)
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
