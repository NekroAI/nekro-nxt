import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { parseFeed, parseHtml, renderSvg } from '../src/extension-render-parse.js'

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">
  <rect width="100%" height="100%" fill="#1d2b44"/>
  <text x="12" y="48" font-size="24" fill="#ffffff" font-family="sans-serif">示例卡片</text>
</svg>`

describe('render.svg', () => {
  it('rasterizes at the requested scale and format', async () => {
    const png = await renderSvg(card)
    expect(png).toMatchObject({ mediaType: 'image/png', width: 400, height: 160 })
    const decoded = await sharp(Buffer.from(png.base64, 'base64')).metadata()
    expect(decoded).toMatchObject({ format: 'png', width: 400, height: 160 })
    expect(png.byteSize).toBe(Buffer.from(png.base64, 'base64').byteLength)

    const jpeg = await renderSvg(card, { format: 'jpeg', scale: 1 })
    expect(jpeg).toMatchObject({ mediaType: 'image/jpeg', width: 200, height: 80 })
  })

  it('refuses local files, external URLs, entities and oversized output', async () => {
    const withImage = (href: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="${href}" width="10" height="10"/></svg>`
    await expect(renderSvg(withImage('file:///etc/hosts'))).rejects.toThrow('只能引用自身片段')
    await expect(renderSvg(withImage('https://example.invalid/a.png'))).rejects.toThrow('只能引用自身片段')
    await expect(
      renderSvg(
        withImage(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        ),
      ),
    ).resolves.toMatchObject({ width: 20 })
    await expect(
      renderSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(file:///x)"/></svg>'),
    ).rejects.toThrow('url()')
    await expect(
      renderSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ).rejects.toThrow('DOCTYPE')
    await expect(
      renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"/>', { scale: 4 }),
    ).rejects.toThrow('无法渲染')
    await expect(renderSvg(card, { scale: 9 })).rejects.toThrow('scale')
  })
})

const page = `<!doctype html><html><head><title>示例站点 · 周报</title></head><body>
  <nav><a href="/">首页</a><a href="/about">关于</a></nav>
  <article>
    <h1>第 12 期周报</h1>
    <p>本周示例项目完成了<strong>三项</strong>改进，详情见<a href="/posts/12">原文</a>。这是一段足够长的正文，用来让正文识别把它当作主要内容。
    这是一段足够长的正文，用来让正文识别把它当作主要内容。这是一段足够长的正文，用来让正文识别把它当作主要内容。</p>
    <table><tr><th>项目</th><th>状态</th></tr><tr><td>示例甲</td><td>完成</td></tr></table>
    <script>alert('x')</script>
    <a href="javascript:void(0)">脚本链接</a>
  </article>
  <footer>版权所有 示例</footer>
</body></html>`

describe('parse.html', () => {
  it('keeps the main content as Markdown with absolute links', () => {
    const parsed = parseHtml(page, { url: 'https://example.com/weekly/' })
    expect(parsed.title).toBe('示例站点 · 周报')
    expect(parsed.markdown).toContain('**三项**')
    expect(parsed.markdown).toContain('[原文](https://example.com/posts/12)')
    expect(parsed.markdown).toMatch(/\| 项目\s+\| 状态\s+\|/u)
    expect(parsed.markdown).not.toContain('alert')
    expect(parsed.markdown).not.toContain('首页')
    expect(parsed.links).toEqual([{ text: '原文', url: 'https://example.com/posts/12' }])
    expect(parsed.truncated).toBe(false)
  })

  it('converts the whole body in full mode and truncates at maxChars', () => {
    const parsed = parseHtml(page, { mode: 'full', maxChars: 40 })
    expect(parsed.markdown.startsWith('[首页]')).toBe(false)
    expect(parsed.truncated).toBe(true)
    expect(parsed.markdown.length).toBeLessThanOrEqual(42)
    expect(parseHtml(page, { mode: 'full' }).markdown).toContain('版权所有')
  })
})

describe('parse.feed', () => {
  it('reads RSS 2.0 items with dates, authors and plain-text summaries', () => {
    const feed = parseFeed(
      `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
        <title>示例博客</title><link>https://blog.example.com/</link><description>示例描述</description>
        <item><title>第一篇 &amp; 更新</title><link>/posts/1</link><guid>post-1</guid>
          <pubDate>Tue, 06 Oct 2026 08:00:00 GMT</pubDate><dc:creator>示例作者</dc:creator>
          <description><![CDATA[<p>摘要<b>内容</b></p>]]></description></item>
        <item><title>第二篇</title><link>https://blog.example.com/posts/2</link></item>
      </channel></rss>`,
    )
    expect(feed).toMatchObject({ kind: 'rss2', title: '示例博客', link: 'https://blog.example.com/' })
    expect(feed.items).toEqual([
      {
        id: 'post-1',
        title: '第一篇 & 更新',
        link: 'https://blog.example.com/posts/1',
        published: Date.UTC(2026, 9, 6, 8),
        author: '示例作者',
        summary: '摘要内容',
      },
      { id: 'https://blog.example.com/posts/2', title: '第二篇', link: 'https://blog.example.com/posts/2' },
    ])
  })

  it('reads Atom alternate links and refuses entity declarations and non-feeds', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>示例动态</title>
        <link rel="self" href="https://example.com/atom.xml"/><link href="https://example.com/"/>
        <entry><id>tag:example.com,2026:1</id><title type="html">条目一</title>
          <link rel="alternate" href="https://example.com/1"/><updated>2026-10-06T08:00:00Z</updated>
          <author><name>示例</name></author><summary>简介</summary></entry>
      </feed>`,
    )
    expect(feed).toMatchObject({ kind: 'atom', title: '示例动态', link: 'https://example.com/' })
    expect(feed.items).toEqual([
      {
        id: 'tag:example.com,2026:1',
        title: '条目一',
        link: 'https://example.com/1',
        published: Date.UTC(2026, 9, 6, 8),
        author: '示例',
        summary: '简介',
      },
    ])
    expect(() => parseFeed('<!DOCTYPE x [<!ENTITY a "b">]><rss/>')).toThrow('实体')
    expect(() => parseFeed('<html><body>不是订阅源</body></html>')).toThrow('没有识别到')
  })
})
