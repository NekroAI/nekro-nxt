import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../check-terminology.mjs', import.meta.url))

test('terminology CLI preserves hard gates without blocking natural Chinese or Adapter names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-terminology-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text)
  }
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const config = (exceptions) =>
    put(
      'scripts/baselines/user-visible-copy-exceptions.json',
      JSON.stringify({
        description: '虚构的术语检查入口夹具。',
        exceptions,
      }),
    )
  const uiFile = 'apps/web/src/fixture.tsx'
  const adapterFile = 'packages/adapter-fixture/src/index.ts'
  const natural = '<p>保存之后仍可继续编辑，不会自动启用。连接成功后才能发送——到「连接」添加账号。</p>'
  await put(uiFile, natural)
  await put(adapterFile, "export const adapter = { displayName: 'QQ 官方机器人', description: '无需逐个进入详情。' }")
  // These composition packages do not own Adapter display copy and need no src directory.
  await mkdir(path.join(root, 'packages/adapter-sdk'))
  await mkdir(path.join(root, 'packages/adapter-builtin-roster'))
  await config([])
  assert.equal(run('--self-test').status, 0)
  const clean = run()
  assert.equal(clean.status, 0, clean.output)
  assert.match(clean.output, /terminology check passed/u)
  assert.doesNotMatch(clean.output, /copy:|warning/iu)

  await put(
    uiFile,
    '<pre>Session Revision Adapter</pre><section data-technical-diagnostic><span>{model.name ?? model.id}</span><p>Agent</p></section>',
  )
  assert.equal(run().status, 0)
  await put(uiFile, `${natural}<p>Agent 示例</p><span>{model.name ?? model.id}</span>`)
  const rejected = run()
  assert.equal(rejected.status, 1, rejected.output)
  assert.match(rejected.output, /\[term:Agent\]/u)
  assert.match(rejected.output, /\[technical-id-fallback\]/u)
  assert.doesNotMatch(rejected.output, /copy:/u)

  const exception = { file: uiFile, rule: 'term:Agent', text: 'Agent 示例', reason: '虚构夹具验证完整文案精确匹配。' }
  await put(uiFile, '<p>Agent 示例</p>')
  await config([exception])
  assert.equal(run().status, 0)
  await put(uiFile, '<p>Agent 其他示例</p>')
  const mismatch = run()
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.output, /\[term:Agent\]/u)
  assert.match(mismatch.output, /未命中的陈旧例外/u)
  await put(uiFile, natural)
  const stale = run()
  assert.equal(stale.status, 1)
  assert.match(stale.output, /未命中的陈旧例外/u)
  await config([exception, exception])
  assert.match(run().output, /包含重复例外/u)
  await config([{ ...exception, rule: 'copy:speculative-negation' }])
  const removedRule = run()
  assert.equal(removedRule.status, 1)
  assert.match(removedRule.output, /不是当前检查器支持的规则/u)

  await config([])
  await put(adapterFile, 'export const adapter = { displayName: model.name || model.adapterId }')
  const adapterId = run()
  assert.equal(adapterId.status, 1)
  assert.match(adapterId.output, /\[technical-id-fallback\]/u)
  await put(adapterFile, "export const adapter = { displayName: 'QQ 官方机器人' }")
  await put(uiFile, '<p>QQ 官方机器人</p>')
  const shellPlatform = run()
  assert.equal(shellPlatform.status, 1)
  assert.match(shellPlatform.output, /\[term:QQ\]/u)
})
