import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'packages/storage-sqlite/package.json'))
const BetterSqlite3 = require('better-sqlite3')
const database = new BetterSqlite3(':memory:')
try {
  database.exec('CREATE TABLE smoke (value TEXT NOT NULL)')
  database.prepare('INSERT INTO smoke (value) VALUES (?)').run(`node-${process.versions.node}`)
  assert.deepEqual(database.prepare('SELECT value FROM smoke').get(), { value: `node-${process.versions.node}` })
  console.log(`better-sqlite3 smoke passed on Node ${process.versions.node}.`)
} finally {
  database.close()
}
