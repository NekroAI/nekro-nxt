import { gfm } from '@joplin/turndown-plugin-gfm'
import { Readability } from '@mozilla/readability'
import { XMLParser } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'
import sharp from 'sharp'
import TurndownService from 'turndown'
import type {
  NxtFeed,
  NxtFeedItem,
  NxtParsedHtml,
  NxtRenderedImage,
  NxtRenderSvgOptions,
  NxtParseHtmlOptions,
} from '@nekro-nxt/extension-sdk'
import { NxtCapabilityError } from './extension-host-service.js'

/** The few DOM members used here; the server compiles without the DOM lib. */
interface ParsedElement {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  readonly textContent: string | null
  readonly innerHTML: string
  readonly outerHTML: string
}
interface ParsedDocument {
  readonly title: string
  readonly body: ParsedElement | null
  readonly documentElement: ParsedElement | null
  querySelectorAll(selector: string): Iterable<ParsedElement>
}

/** linkedom only builds `head` and `body` for a whole document, so fragments are wrapped first. */
const linkedomDocument = (html: string) =>
  parseHTML(/^\s*(?:<!doctype|<html)/iu.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`).document

const createDocument = (html: string): ParsedDocument => linkedomDocument(html)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const RENDER_SVG_MAX_CHARS = 2 * 1024 * 1024
export const RENDER_MAX_PIXELS = 4096 * 4096
export const PARSE_HTML_MAX_CHARS = 5 * 1024 * 1024
export const PARSE_FEED_MAX_CHARS = 5 * 1024 * 1024
const PARSE_MARKDOWN_DEFAULT_MAX_CHARS = 20_000
const PARSE_MARKDOWN_MAX_CHARS = 200_000
const PARSE_MAX_LINKS = 200
const FEED_MAX_ITEMS = 100
const FEED_SUMMARY_MAX_CHARS = 2000

const RENDER_FORMATS = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

/**
 * SVG may only reference its own fragments and inline `data:` URLs: librsvg would otherwise read local files into the
 * picture. Entity declarations are refused so a document cannot expand or pull external entities.
 */
const checkSvgReferences = (svg: string): void => {
  if (/<!DOCTYPE|<!ENTITY/iu.test(svg)) throw new NxtCapabilityError('SVG 不能包含 DOCTYPE 或实体声明。')
  for (const match of svg.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/giu)) {
    const target = (match[2] ?? '').trim()
    if (!target.startsWith('#') && !/^data:/iu.test(target)) {
      throw new NxtCapabilityError('SVG 只能引用自身片段或 data: 内联资源；网络图片请先用 http.fetch 取回再内联。')
    }
  }
  if (/url\(\s*(["']?)(?!#|data:)[^)]*\)/iu.test(svg)) {
    throw new NxtCapabilityError('SVG 样式中的 url() 只能指向自身片段或 data: 内联资源。')
  }
}

/** Rasterizes an SVG with the system fonts; text should name generic families such as `sans-serif`. */
export const renderSvg = async (svg: string, options: NxtRenderSvgOptions = {}): Promise<NxtRenderedImage> => {
  if (typeof svg !== 'string' || svg.trim() === '') throw new NxtCapabilityError('render.svg 需要 SVG 文本。')
  if (svg.length > RENDER_SVG_MAX_CHARS) throw new NxtCapabilityError('SVG 超过 2 MiB。')
  checkSvgReferences(svg)
  const format = options.format ?? 'png'
  if (!(format in RENDER_FORMATS)) throw new NxtCapabilityError('format 只能是 png、jpeg 或 webp。')
  const scale = options.scale ?? 2
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new NxtCapabilityError('scale 需要在 0 到 4 之间。')
  try {
    let image = sharp(Buffer.from(svg), { density: 72 * scale, limitInputPixels: RENDER_MAX_PIXELS })
    if (options.background !== undefined) image = image.flatten({ background: options.background })
    const output =
      format === 'png'
        ? image.png()
        : format === 'jpeg'
          ? image.flatten({ background: options.background ?? '#ffffff' }).jpeg({ quality: 88 })
          : image.webp({ quality: 88 })
    const { data, info } = await output.toBuffer({ resolveWithObject: true })
    return {
      base64: data.toString('base64'),
      mediaType: RENDER_FORMATS[format],
      width: info.width,
      height: info.height,
      byteSize: data.byteLength,
    }
  } catch (error) {
    throw new NxtCapabilityError(`SVG 无法渲染：${error instanceof Error ? error.message : String(error)}`)
  }
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
})
turndown.use(gfm)
const REMOVED_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEMPLATE', 'SVG', 'CANVAS', 'FORM'])
turndown.remove(
  (node: unknown) =>
    isRecord(node) && typeof node['nodeName'] === 'string' && REMOVED_ELEMENTS.has(node['nodeName'].toUpperCase()),
)

const resolveUrl = (href: string, base: string | undefined): string | undefined => {
  try {
    const url = new URL(href, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const truncated = (text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } =>
  text.length <= maxChars ? { text, truncated: false } : { text: `${text.slice(0, maxChars)}\n…`, truncated: true }

/**
 * HTML to Markdown. `article` (default) keeps the main content as Readability finds it and falls back to the whole
 * body; `full` converts the body. Links are absolute when `url` is given.
 */
export const parseHtml = (html: string, options: NxtParseHtmlOptions = {}): NxtParsedHtml => {
  if (typeof html !== 'string') throw new NxtCapabilityError('parse.html 需要 HTML 文本。')
  if (html.length > PARSE_HTML_MAX_CHARS) throw new NxtCapabilityError('HTML 超过 5 MiB。')
  const maxChars = Math.min(
    Math.max(1, Math.trunc(options.maxChars ?? PARSE_MARKDOWN_DEFAULT_MAX_CHARS)),
    PARSE_MARKDOWN_MAX_CHARS,
  )
  const base = options.url === undefined ? undefined : resolveUrl(options.url, undefined)
  const document = createDocument(html)
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = resolveUrl(anchor.getAttribute('href') ?? '', base)
    if (href === undefined) anchor.removeAttribute('href')
    else anchor.setAttribute('href', href)
  }
  for (const image of Array.from(document.querySelectorAll('img[src]'))) {
    const src = resolveUrl(image.getAttribute('src') ?? '', base)
    if (src === undefined) image.removeAttribute('src')
    else image.setAttribute('src', src)
  }
  const pageTitle = document.title.trim()
  let contentHtml = document.body?.innerHTML ?? html
  let title = pageTitle
  let excerpt: string | undefined
  if ((options.mode ?? 'article') === 'article') {
    // Readability mutates the document it reads, so it gets its own copy.
    const article = new Readability(linkedomDocument(document.documentElement?.outerHTML ?? html), {
      charThreshold: 200,
    }).parse()
    if (article?.content) {
      contentHtml = article.content
      title = article.title?.trim() || pageTitle
      excerpt = article.excerpt?.trim() || undefined
    }
  }
  const content = createDocument(contentHtml)
  const links: { text: string; url: string }[] = []
  const seen = new Set<string>()
  for (const anchor of Array.from(content.querySelectorAll('a[href]'))) {
    const url = anchor.getAttribute('href') ?? ''
    if (seen.has(url) || links.length >= PARSE_MAX_LINKS) continue
    seen.add(url)
    links.push({ text: (anchor.textContent ?? '').replace(/\s+/gu, ' ').trim(), url })
  }
  const markdown = turndown
    .turndown(content.body?.innerHTML ?? '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const result = truncated(markdown, maxChars)
  return {
    ...(title === '' ? {} : { title }),
    ...(excerpt === undefined ? {} : { excerpt }),
    markdown: result.text,
    truncated: result.truncated,
    links,
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  removeNSPrefix: true,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
})

const textOf = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return textOf(value[0])
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isRecord(value)) return textOf(value['#text'])
  return undefined
}

const plainText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const text = (createDocument(value).body?.textContent ?? value).replace(/\s+/gu, ' ').trim()
  return text === '' ? undefined : truncated(text, FEED_SUMMARY_MAX_CHARS).text
}

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value]

/** RSS links are text; Atom links are elements whose `rel` is absent or `alternate`. */
const linkOf = (value: unknown, base: string | undefined): string | undefined => {
  for (const link of listOf(value)) {
    if (typeof link === 'string') return resolveUrl(link, base)
    if (isRecord(link)) {
      const rel = link['@rel']
      const href = link['@href']
      if (typeof href === 'string' && (rel === undefined || rel === 'alternate')) return resolveUrl(href, base)
      const text = textOf(link)
      if (text !== undefined && href === undefined) return resolveUrl(text, base)
    }
  }
  return undefined
}

const dateOf = (...values: readonly unknown[]): number | undefined => {
  for (const value of values) {
    const text = textOf(value)
    if (text === undefined) continue
    const time = Date.parse(text)
    if (Number.isFinite(time)) return time
  }
  return undefined
}

const authorOf = (value: unknown): string | undefined =>
  (isRecord(value) ? textOf(value['name']) : undefined) ?? textOf(value)

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

/** RSS 2.0, RSS 1.0 (RDF) and Atom into one shape; items keep feed order. */
export const parseFeed = (text: string, options: { readonly url?: string } = {}): NxtFeed => {
  if (typeof text !== 'string' || text.trim() === '') throw new NxtCapabilityError('parse.feed 需要 XML 文本。')
  if (text.length > PARSE_FEED_MAX_CHARS) throw new NxtCapabilityError('订阅源超过 5 MiB。')
  if (/<!ENTITY/iu.test(text)) throw new NxtCapabilityError('订阅源不能包含实体声明。')
  let parsed: unknown
  try {
    parsed = xml.parse(text)
  } catch (error) {
    throw new NxtCapabilityError(`订阅源不是有效的 XML：${error instanceof Error ? error.message : String(error)}`)
  }
  const document = recordOf(parsed)
  const rss = recordOf(document['rss'])
  const rdf = recordOf(document['RDF'])
  const atom = recordOf(document['feed'])
  const channel = recordOf(rss['channel'] ?? rdf['channel'])
  const isAtom = Object.keys(atom).length > 0
  if (!isAtom && Object.keys(channel).length === 0) throw new NxtCapabilityError('没有识别到 RSS 或 Atom 订阅源。')
  const base = options.url === undefined ? undefined : resolveUrl(options.url, undefined)
  const head = isAtom ? atom : channel
  const feedLink = linkOf(head['link'], base) ?? base
  const entries = listOf(isAtom ? atom['entry'] : (channel['item'] ?? rdf['item'])).slice(0, FEED_MAX_ITEMS)
  const items: NxtFeedItem[] = entries.map((entry) => {
    const item = recordOf(entry)
    const link = linkOf(item['link'], feedLink)
    const title = plainText(textOf(item['title']))
    const summary = plainText(textOf(item['summary'] ?? item['description'] ?? item['content'] ?? item['encoded']))
    const published = dateOf(item['published'], item['pubDate'], item['date'], item['updated'])
    const author = authorOf(item['author'] ?? item['creator'])
    const id = textOf(item['id'] ?? item['guid']) ?? link ?? title ?? ''
    return {
      id,
      ...(title === undefined ? {} : { title }),
      ...(link === undefined ? {} : { link }),
      ...(published === undefined ? {} : { published }),
      ...(author === undefined ? {} : { author }),
      ...(summary === undefined ? {} : { summary }),
    }
  })
  const title = plainText(textOf(head['title']))
  const description = plainText(textOf(head['description'] ?? head['subtitle']))
  return {
    kind: isAtom ? 'atom' : Object.keys(rdf).length > 0 ? 'rss1' : 'rss2',
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(feedLink === undefined ? {} : { link: feedLink }),
    items,
  }
}
