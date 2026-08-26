import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { workspaceSourceAliases } from '../workspace-source-aliases.mjs'

const root = process.cwd()
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', cwd: root }).split('\0').filter(Boolean),
)

test('workspace source aliases point at tracked TypeScript entries', () => {
  const missing = []
  for (const [id, target] of Object.entries(workspaceSourceAliases)) {
    const relative = path.relative(root, target).split(path.sep).join('/')
    if (
      !existsSync(target) ||
      !tracked.has(relative) ||
      !relative.startsWith('packages/') ||
      !relative.endsWith('.ts')
    ) {
      missing.push(`${id} -> ${relative}`)
    }
  }
  assert.deepEqual(missing, [])
  assert.ok(workspaceSourceAliases['@nekro-nxt/contracts']?.endsWith('packages/contracts/src/index.ts'))
})

test('every workspace package has a source alias', () => {
  const packageNames = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'packages', entry.name, 'package.json'))
    .filter(existsSync)
    .map((packageJson) => JSON.parse(readFileSync(packageJson, 'utf8')).name)
    .filter((name) => typeof name === 'string')
    .sort()
  const missing = packageNames.filter((name) => workspaceSourceAliases[name] === undefined)

  assert.deepEqual(missing, [])
})
