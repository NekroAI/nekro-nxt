#!/usr/bin/env node
/**
 * 生成 `@nekro-nxt/extension-sdk` 的 npm 发布目录 `packages/extension-sdk/publish/`。
 *
 * 仓库内的 SDK 依赖未公开的 adapter-sdk 与 dsh-compat；发布物把它们的运行时与类型内联，
 * 只依赖已公开的 `@nekro-nxt/contracts`，扩展仓库安装后即可独立类型检查。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = path.join(root, 'packages/extension-sdk')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const sdk = readJson(path.join(sdkDir, 'package.json'))
const contracts = readJson(path.join(root, 'packages/contracts/package.json'))

execFileSync('pnpm', ['exec', 'tsdown', '-c', 'tsdown.publish.config.ts'], { cwd: sdkDir, stdio: 'inherit' })

const publishDir = path.join(sdkDir, 'publish')
const manifest = {
  name: sdk.name,
  version: sdk.version,
  description: sdk.description,
  license: 'MIT',
  type: 'module',
  exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' } },
  files: ['dist', 'LICENSE', 'README.md'],
  dependencies: {
    '@nekro-nxt/contracts': `^${contracts.version}`,
    zod: contracts.dependencies.zod,
  },
  peerDependencies: { '@types/react': '>=18' },
  peerDependenciesMeta: { '@types/react': { optional: true } },
  publishConfig: { access: 'public' },
  author: sdk.author,
  homepage: 'https://github.com/NekroAI/nekro-nxt/tree/main/packages/extension-sdk#readme',
  repository: { type: 'git', url: 'git+https://github.com/NekroAI/nekro-nxt.git', directory: 'packages/extension-sdk' },
  bugs: sdk.bugs,
}
writeFileSync(path.join(publishDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(path.join(sdkDir, 'LICENSE'), path.join(publishDir, 'LICENSE'))
copyFileSync(path.join(sdkDir, 'PUBLISH-README.md'), path.join(publishDir, 'README.md'))
console.log(`已生成 ${sdk.name}@${sdk.version} 发布目录：${path.relative(root, publishDir)}`)
