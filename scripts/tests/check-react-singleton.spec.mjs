import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkReactSingleton } from '../check-react-singleton.mjs'

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-react-singleton-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const write = async (filename, value) => {
    const destination = path.join(root, filename)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, JSON.stringify(value))
  }
  const version = '18.3.1'
  await write('apps/web/package.json', { dependencies: { react: version, 'react-dom': version } })
  await write('packages/dsh-compat/package.json', { dependencies: { react: version, 'react-dom': version } })
  for (const name of ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-renderer']) {
    await write(`node_modules/${name}/package.json`, { name, version, exports: { './package.json': './package.json' } })
  }
  return { root, write, version }
}

test('checks the public UI renderer with Web and compat without the removed Client Runtime', async (context) => {
  const input = await fixture(context)
  assert.deepEqual(await checkReactSingleton(input), [])
})

for (const name of ['react', 'react-dom']) {
  test(`refuses a second ${name} instance under the renderer even at the same version`, async (context) => {
    const input = await fixture(context)
    await input.write(`node_modules/@deepseek-ai/dsh-client-ui-renderer/node_modules/${name}/package.json`, {
      name,
      version: input.version,
      exports: { './package.json': './package.json' },
    })
    const errors = await checkReactSingleton(input)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].startsWith(`${name} 未解析为同一个`))
  })
}

test('keeps rejecting unpinned workspace React declarations', async (context) => {
  const input = await fixture(context)
  await input.write('apps/web/package.json', { dependencies: { react: '^18.3.1' } })
  assert.match((await checkReactSingleton(input)).join('\n'), /dependencies.react 必须固定/u)
})
