import assert from 'node:assert/strict'
import test from 'node:test'
import { applyFlows, bundleOf, headingAnchor, parseFrontMatter, readSite } from '../docs-bundle.mjs'

test('page front matter accepts only the documented keys and list syntax', () => {
  const { fields, body } = parseFrontMatter(
    '---\nsummary: 一句话\nui: [设置 → 模型]\nkeywords: [模型, API Key]\n---\n\n# 标题\n',
    'a.md',
  )
  assert.deepEqual(fields, { summary: '一句话', ui: ['设置 → 模型'], keywords: ['模型', 'API Key'], routes: [] })
  assert.equal(body, '\n# 标题\n')
  assert.throws(() => parseFrontMatter('# 标题\n', 'a.md'), /缺少页面头部/u)
  assert.throws(() => parseFrontMatter('---\nui: [a]\n---\n', 'a.md'), /缺少 summary/u)
  assert.throws(() => parseFrontMatter('---\nsummary: x\ntitle: y\n---\n', 'a.md'), /无法识别/u)
  assert.throws(() => parseFrontMatter('---\nsummary: x\nui: a, b\n---\n', 'a.md'), /\[a, b\]/u)
})

test('heading anchors follow GitHub, counting repeats across levels', () => {
  const counts = new Map()
  assert.equal(headingAnchor('通过反向代理使用 HTTPS', counts), '通过反向代理使用-https')
  assert.equal(headingAnchor('下载', counts), '下载')
  assert.equal(headingAnchor('下载', counts), '下载-1')
  assert.equal(headingAnchor('Docker Compose：示例', counts), 'docker-compose示例')
})

test('the repository documentation builds into a bundle with resolved links', async () => {
  const site = await readSite({ commit: 'a'.repeat(40) })
  assert.deepEqual(site.errors, [])
  const bundle = bundleOf(
    site,
    { channel: 'preview', version: '0.0.0-test', commit: 'a'.repeat(40) },
    '2026-01-01T00:00:00.000Z',
  )
  assert.equal(bundle.schemaVersion, 1)
  const ids = new Set(bundle.pages.map((page) => page.id))
  for (const section of bundle.sections) for (const id of section.pages) assert.ok(ids.has(id), id)
  for (const page of bundle.pages) {
    assert.doesNotMatch(page.markdown, /^# /mu, page.id)
    for (const link of page.markdown.matchAll(/\]\((\/docs\/[^)#]+)/gu))
      assert.ok(ids.has(link[1].slice(6)), `${page.id} → ${link[1]}`)
    assert.doesNotMatch(page.markdown, /\]\((?:\.\.\/|\.\/)?[^):#]+\.md/u, `${page.id} 仍有相对 .md 链接`)
  }
})

test('flow reports turn into shots and stale pages, falling back to the previous bundle', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'docs-flows-'))
  const page = (id, flow, shots, terms) => ({
    id,
    file: `docs/site/${id}.md`,
    fields: { flow },
    shots: new Set(shots),
    terms,
  })
  const site = {
    assets: new Map(),
    pages: new Map([
      ['a/fresh', page('a/fresh', 'ok', ['ok-shot'], ['设置', '模型'])],
      ['a/renamed', page('a/renamed', 'ok', ['renamed-shot'], ['旧按钮'])],
      ['a/broken', page('a/broken', 'broken', ['old-shot', 'never-shot'], [])],
      ['a/plain', page('a/plain', undefined, [], ['随便'])],
    ]),
  }
  await writeFile(
    path.join(dir, 'ok.json'),
    JSON.stringify({
      status: 'passed',
      shots: { 'ok-shot': { width: 800, height: 600 }, 'renamed-shot': { width: 800, height: 600 } },
      texts: ['设置', '模型 ID'],
    }),
  )
  await writeFile(
    path.join(dir, 'broken.json'),
    JSON.stringify({ status: 'failed', error: '找不到按钮', shots: {}, texts: [] }),
  )
  await writeFile(path.join(dir, 'ok-shot.light.webp'), 'light')
  await writeFile(path.join(dir, 'ok-shot.dark.webp'), 'dark')
  await writeFile(path.join(dir, 'renamed-shot.light.webp'), 'renamed light')
  await writeFile(path.join(dir, 'renamed-shot.dark.webp'), 'renamed dark')
  const previous = {
    'old-shot': { light: 'https://x/l.webp', dark: 'https://x/d.webp', width: 1, height: 1 },
    'renamed-shot': { light: 'https://x/old-l.webp', dark: 'https://x/old-d.webp', width: 1, height: 1 },
  }

  const { shots, stale, missing } = applyFlows(site, dir, previous)
  assert.equal(shots['ok-shot'].width, 800)
  assert.match(shots['ok-shot'].light, /^https:\/\/dl\.nekro\.ai\/nxt\/docs\/assets\/[0-9a-f]{16}\.webp$/u)
  assert.notEqual(shots['ok-shot'].light, shots['ok-shot'].dark)
  assert.deepEqual(shots['renamed-shot'], previous['renamed-shot'])
  assert.equal(site.assets.size, 2)
  assert.deepEqual(shots['old-shot'], previous['old-shot'])
  assert.deepEqual([...stale.keys()], ['a/renamed', 'a/broken'])
  assert.match(stale.get('a/renamed')[0], /「旧按钮」/u)
  assert.match(stale.get('a/broken')[0], /找不到按钮/u)
  assert.deepEqual(missing, ['docs/site/a/broken.md：截图 never-shot 没有生成，上一版也没有'])
})
