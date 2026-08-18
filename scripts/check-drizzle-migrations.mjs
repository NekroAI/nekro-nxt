import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { readBaseline, writeBaseline } from './lib/quality-baseline.mjs'

const root = process.cwd()
const packageRoot = path.join(root, 'packages/storage-sqlite')
const migrationsRoot = path.join(packageRoot, 'migrations')
const schemaPath = path.join(packageRoot, 'src/schema.ts')
const baselinePath = 'scripts/baselines/drizzle-migrations.json'

async function filesBelow(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await filesBelow(path.join(directory, entry.name), relative)))
    else result.push(relative)
  }
  return result.sort()
}

async function hashes(directory) {
  const result = {}
  for (const file of await filesBelow(directory)) {
    const content = await readFile(path.join(directory, file))
    result[file] = createHash('sha256').update(content).digest('hex')
  }
  return result
}

async function generate(out, name) {
  const arguments_ = [
    '--dir',
    'packages/storage-sqlite',
    'exec',
    'drizzle-kit',
    'generate',
    '--dialect',
    'sqlite',
    '--schema',
    schemaPath,
    '--out',
    out,
    '--name',
    name,
  ]
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', arguments_, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`drizzle-kit generate failed (${code ?? 'signal'}):\n${output}`))
    })
  })
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-drizzle-'))
try {
  const copied = path.join(temporaryRoot, 'current')
  await cp(migrationsRoot, copied, { recursive: true })
  const beforeGenerate = await hashes(copied)
  await generate(copied, 'gate_check')
  const afterGenerate = await hashes(copied)
  if (JSON.stringify(afterGenerate) !== JSON.stringify(beforeGenerate)) {
    const added = Object.keys(afterGenerate).filter((file) => !(file in beforeGenerate))
    throw new Error(
      `Drizzle schema 与已提交 snapshots 不一致；重新生成产生了变化${added.length ? `：${added.join(', ')}` : ''}`,
    )
  }

  const actual = await hashes(migrationsRoot)
  const journal = JSON.parse(await readFile(path.join(migrationsRoot, 'meta/_journal.json'), 'utf8'))
  if (journal.entries?.length === 1 && journal.entries[0]?.idx === 0) {
    const fresh = path.join(temporaryRoot, 'fresh')
    await generate(fresh, 'initial')
    const committedSql = Object.keys(actual).filter((file) => file.endsWith('.sql'))
    const freshSql = (await filesBelow(fresh)).filter((file) => file.endsWith('.sql'))
    if (committedSql.length !== 1 || freshSql.length !== 1) {
      throw new Error('单 migration 仓库必须能从 schema 重新生成唯一 SQL。')
    }
    const [committed, regenerated] = await Promise.all([
      readFile(path.join(migrationsRoot, committedSql[0]), 'utf8'),
      readFile(path.join(fresh, freshSql[0]), 'utf8'),
    ])
    if (committed !== regenerated) {
      throw new Error(`${committedSql[0]} 不是当前 schema 的原样 Drizzle 生成结果，疑似人工修改。`)
    }
  }

  if (process.argv.includes('--write-baseline')) {
    await writeBaseline(root, baselinePath, {
      version: 1,
      description: 'Drizzle 生成物 SHA-256；任何 migration/meta 改动必须先通过重新生成一致性检查。',
      files: actual,
    })
    console.log(`Drizzle migration baseline updated (${Object.keys(actual).length} files).`)
    process.exit(0)
  }

  const baseline = await readBaseline(root, baselinePath)
  const errors = []
  for (const file of new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(actual)])) {
    if (actual[file] !== baseline.files?.[file]) errors.push(file)
  }
  if (errors.length > 0) {
    throw new Error(`Drizzle migration 生成物未经门禁基线确认：${errors.join(', ')}`)
  }
  console.log(`Drizzle migration check passed (${Object.keys(actual).length} generated files).`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
