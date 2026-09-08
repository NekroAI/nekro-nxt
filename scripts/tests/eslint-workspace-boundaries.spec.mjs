import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Linter } from 'eslint'
import { workspaceBoundariesRule } from '../lib/eslint-workspace-boundaries.mjs'

const check = (code, file = 'apps/server/src/fixture.js') =>
  new Linter().verify(
    code,
    [
      {
        plugins: { workspace: { rules: { boundaries: workspaceBoundariesRule } } },
        rules: { 'workspace/boundaries': 'error' },
      },
    ],
    { filename: path.resolve(file) },
  )

test('workspace import checks enforce public exports and isolate concrete adapters and native databases', () => {
  assert.equal(check("import { value } from '@nekro-nxt/contracts';").length, 0)
  assert.equal(check("import('@nekro-nxt/contracts/src/private')").length, 1)
  assert.equal(check("export * from '@nekro-nxt/contracts/private'").length, 1)
  assert.equal(check("import '@nekro-nxt/adapter-onebot-11'").length, 1)
  assert.equal(check("import '@nekro-nxt/adapter-builtin-roster'").length, 0)
  assert.equal(check("import '@nekro-nxt/adapter-builtin-roster'", 'apps/web/src/fixture.js').length, 1)
  assert.equal(check("import 'better-sqlite3'").length, 1)
  assert.equal(check("import 'better-sqlite3'", 'packages/storage-sqlite/src/fixture.js').length, 0)
})
