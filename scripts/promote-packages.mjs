#!/usr/bin/env node
// Points the `latest` dist-tag of every shared package at its local version, which must already be on npm (usually
// under `next`). Run by the maintainer before `pnpm release`; npm asks for the 2FA code.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localPublicPackages, npmDistTags } from './lib/npm-packages.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

async function main() {
  const packages = await localPublicPackages(repositoryRoot)
  const missing = packages.filter(({ name, version }) => {
    const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
    return result.status !== 0 || result.stdout.trim() !== version
  })
  if (missing.length > 0) {
    throw new Error(
      `${missing.map(({ name, version }) => `${name}@${version}`).join('、')} 还没有发布到 npm：先推送 packages-v* Tag 并在 npm 确认暂存。`,
    )
  }
  for (const { name, version } of packages) {
    if (npmDistTags(name)['latest'] === version) {
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
