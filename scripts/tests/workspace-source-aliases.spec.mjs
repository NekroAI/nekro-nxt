import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
