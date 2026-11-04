import { spawnSync } from 'node:child_process'

/** Exercise compressed Session files with the packaged executable and its own dependency tree. */
export function verifyNativeSessionPersistence(executable, runtimeRoot) {
  const source = `
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = await mkdtemp(path.join(tmpdir(), 'nxt-artifact-jsonl-'))
const writerContext = new Context()
const readerContext = new Context()
try {
  await writerContext.plugin(JsonlSessionPersistence, { root })
  const session = Session.create(SessionId('synthetic-artifact-session'))
  const writer = await writerContext.sessionPersistence.create(session.header)
  await writer.append([
    session.append('turn/start', { turn: 1 }),
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  await writer.flush()
  await writer.close()
  await writerContext.fiber.dispose()
  await readerContext.plugin(JsonlSessionPersistence, { root })
  const reader = await readerContext.sessionPersistence.open(session.id, 'read')
  try {
    const { events } = await reader.read()
    if (events.length !== 2 || events[0].type !== 'turn/start' || events[1].type !== 'turn/end') throw new Error('Packaged JSONL roundtrip mismatch')
  } finally { await reader.close() }
  console.log('[runtime-native] Compressed JSONL write, flush and reopen passed.')
} finally {
  await writerContext.fiber.dispose()
  await readerContext.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
`
  const result = spawnSync(executable, ['--input-type=module', '--eval', source], {
    cwd: runtimeRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 60_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Packaged JSONL native verification failed (${result.status ?? result.signal}).`)
}

/** Load sharp and the extension builder's esbuild with the packaged executable, so a pruned runtime that lost a target binary fails here. */
export function verifyNativeMediaAndBuilder(executable, runtimeRoot) {
  const source = `
import { createRequire } from 'node:module'
import path from 'node:path'
import sharp from 'sharp'
const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer()
const metadata = await sharp(image).resize(2, 2).metadata()
if (metadata.format !== 'png') throw new Error('Packaged sharp roundtrip mismatch')
// 与扩展构建器解析同一个 esbuild，避免检查到另一个版本。
const requireFromBuilder = createRequire(path.join(process.cwd(), 'node_modules/@nekro-nxt/extension-runtime/package.json'))
const esbuild = requireFromBuilder('esbuild')
const result = await esbuild.transform('const answer: number = 42; export default answer', { loader: 'ts', format: 'esm' })
if (!result.code.includes('42')) throw new Error('Packaged esbuild transform mismatch')
await esbuild.stop?.()
console.log('[runtime-native] sharp ' + sharp.versions.sharp + ' and esbuild ' + esbuild.version + ' loaded for ' + process.platform + '-' + process.arch + '.')
`
  const result = spawnSync(executable, ['--input-type=module', '--eval', source], {
    cwd: runtimeRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 60_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Packaged sharp/esbuild verification failed (${result.status ?? result.signal}).`)
}
