#!/usr/bin/env node
// A Preview may only ship an extension capability level that the shared packages on npm already know: the community
// validates packages with those, so a newer level in Preview lets users build extensions the community rejects.
// The release order is in docs/09-正式发布与更新日志规范.md §5.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LEVEL = /EXTENSION_SDK_LEVEL\s*=\s*(\d+)/u

/**
 * @param {string} text
 * @returns {number | undefined}
 */
export function readLevel(text) {
  const match = LEVEL.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * @param {{ readonly local: number, readonly published: number, readonly publishedVersion: string }} input
 * @returns {string | undefined} why the Preview must wait, or undefined when it may ship
 */
export function levelProblem({ local, published, publishedVersion }) {
  if (local <= published) return undefined
  return [
    `本地扩展能力等级是 ${local}，npm 上的 @nekro-nxt/contracts ${publishedVersion} 只到 ${published}。`,
    '社区按 npm 上的共享包审核扩展，现在发布 Preview，用户做出的新扩展会被社区拒收。',
    '先发布共享包（packages-v* Tag，并在 npm 确认暂存），再升级并部署社区，然后重新运行这次 CI。',
  ].join('\n')
}

async function publishedLevel() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-published-contracts-'))
  try {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '@nekro-nxt/contracts@latest', '--json', '--pack-destination', directory], {
        encoding: 'utf8',
      }),
    )
    const { filename, version } = packed[0]
    execFileSync('tar', ['-xzf', path.join(directory, filename), '-C', directory])
    const dist = path.join(directory, 'package', 'dist')
    for (const file of await readdir(dist)) {
      if (!file.endsWith('.mjs')) continue
      const level = readLevel(await readFile(path.join(dist, file), 'utf8'))
      if (level !== undefined) return { level, version }
    }
    throw new Error(`没有在 @nekro-nxt/contracts ${version} 里找到 EXTENSION_SDK_LEVEL。`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const source = fileURLToPath(new URL('../packages/contracts/src/extension-capabilities.ts', import.meta.url))
  const local = readLevel(await readFile(source, 'utf8'))
  if (local === undefined) throw new Error(`没有在 ${source} 里找到 EXTENSION_SDK_LEVEL。`)
  const published = await publishedLevel()
  const problem = levelProblem({ local, published: published.level, publishedVersion: published.version })
  if (problem !== undefined) {
    console.error(problem)
    process.exitCode = 1
    return
  }
  console.log(`扩展能力等级 ${local}，npm 上的 @nekro-nxt/contracts ${published.version} 支持到 ${published.level}。`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
