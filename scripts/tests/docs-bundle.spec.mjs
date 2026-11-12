import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleOf, headingAnchor, parseFrontMatter, readSite } from '../docs-bundle.mjs'

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
