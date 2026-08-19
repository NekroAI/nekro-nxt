import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()
const sourcePattern = /\.(?:mjs|js)$/u
const importPattern = /from\s+['"](\.[^'"]+)['"]/gu

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', cwd: root }).split('\0').filter(Boolean),
)

async function scriptFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await scriptFiles(target)))
    else if (sourcePattern.test(entry.name)) files.push(target)
  }
  return files
}

test('check scripts only import git-tracked local modules', async () => {
  const missing = []
  for (const file of await scriptFiles(path.join(root, 'scripts'))) {
    const text = await readFile(file, 'utf8')
    const source = path.relative(root, file).split(path.sep).join('/')
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1]
      const resolved = path
        .relative(root, path.resolve(path.dirname(file), specifier))
        .split(path.sep)
        .join('/')
      if (!tracked.has(resolved)) missing.push(`${source} -> ${resolved}`)
    }
  }
  assert.deepEqual(missing, [])
})
