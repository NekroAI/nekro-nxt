// Builds the user documentation in docs/site into the bundle the community site serves at /docs.
//   node scripts/docs-bundle.mjs check                      validate pages, the generated index and docs links in code
//   node scripts/docs-bundle.mjs readme                     regenerate docs/site/README.md and the help button's routes
//   node scripts/docs-bundle.mjs build <stable|preview> [--out .local/docs-bundle] [--shots .local/docs-shots] [--strict]
//   node scripts/docs-bundle.mjs upload <stable|preview> [--out .local/docs-bundle]   needs R2_ACCOUNT_ID and keys
// Bundle format: docs/site/BUNDLE.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { r2Aws, retrying } from './mirror-desktop-release.mjs'
import { readProductRelease } from './product-release.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteRoot = 'docs/site'
const readmePath = `${siteRoot}/README.md`
const routesPath = 'apps/web/src/app/shell/docs-routes.ts'
export const DOCS_ORIGIN = 'https://nxt.nekro.ai'
const DIST_ORIGIN = 'https://dl.nekro.ai/nxt/docs'
const ASSET_ORIGIN = `${DIST_ORIGIN}/assets`
const REPOSITORY_URL = 'https://github.com/NekroAI/nekro-nxt'
const FRONT_MATTER_KEYS = new Set(['summary', 'ui', 'routes', 'keywords', 'since', 'flow'])
const LIST_KEYS = new Set(['ui', 'routes', 'keywords'])
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SITE_DIRECTORIES = new Set(['images', 'media', 'flows'])
const MEDIA_EXTENSIONS = ['.webp', '.png', '.jpg']
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

/** Front matter is a strict subset of YAML: `key: value` and `key: [a, b]` lines only. */
export function parseFrontMatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/u)
  if (!match) throw new Error(`${file}：缺少页面头部（--- 包围的 summary、ui、routes、keywords）`)
  const fields = {}
  for (const line of match[1].split('\n')) {
    const entry = line.match(/^([a-z]+):\s*(.*)$/u)
    if (!entry || !FRONT_MATTER_KEYS.has(entry[1])) throw new Error(`${file}：页面头部无法识别的行「${line}」`)
    const [, key, raw] = entry
    if (LIST_KEYS.has(key)) {
      const list = raw.match(/^\[(.*)\]$/u)
      if (!list) throw new Error(`${file}：${key} 要写成 [a, b]`)
      fields[key] = list[1].trim() === '' ? [] : list[1].split(',').map((item) => item.trim())
      if (fields[key].some((item) => item === '')) throw new Error(`${file}：${key} 有空项`)
    } else {
      if (raw.trim() === '') throw new Error(`${file}：${key} 不能为空`)
      fields[key] = raw.trim()
    }
  }
  if (fields.summary === undefined) throw new Error(`${file}：页面头部缺少 summary`)
  for (const key of LIST_KEYS) fields[key] ??= []
  return { fields, body: text.slice(match[0].length) }
}

/** GitHub-compatible heading anchors; duplicates count across every heading level, as GitHub does. */
export function headingAnchor(text, counts) {
  const base = text
    .replace(/<[^>]+>/gu, '')
    .replace(/[\p{P}\p{S}]/gu, (character) => (character === '-' || character === '_' ? character : ''))
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '-')
  const count = counts.get(base) ?? 0
  counts.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

/** Lines outside fenced code blocks, with their index, so headings and links in code are left alone. */
function* proseLines(lines) {
  let fence = null
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)
    if (marker) {
      if (fence === null) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence === null) yield [index, line]
  }
}

const plainHeading = (text) =>
  text
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/\*\*([^*]*)\*\*/gu, '$1')
    .trim()

/** Shot names a flow declares with `docs.shot('name', …)`; a page may only show shots of its own flow. */
async function readFlowShots(flow) {
  const file = path.join(repositoryRoot, siteRoot, 'flows', `${flow}.flow.ts`)
  if (!existsSync(file)) return null
  return new Set([...(await readFile(file, 'utf8')).matchAll(/\.shot\(\s*'([a-z0-9-]+)'/gu)].map((match) => match[1]))
}

/** Interface words a page quotes in 「」, split at → so 「设置 → 模型」 means both 设置 and 模型. */
const quotedTerms = (lines) => {
  const terms = new Set()
  for (const [, line] of proseLines(lines))
    for (const match of line.replace(/`[^`]*`/gu, '').matchAll(/「([^」]+)」/gu))
      for (const term of match[1].split('→')) if (term.trim() !== '') terms.add(term.trim())
  return [...terms]
}

async function readSections() {
  const raw = JSON.parse(await readFile(path.join(repositoryRoot, siteRoot, 'sections.json'), 'utf8'))
  return raw.sections.map((section) => {
    if (!ID_PATTERN.test(section.id) || typeof section.title !== 'string')
      throw new Error(`sections.json：栏目 ${section.id} 无效`)
    for (const slug of section.pages) if (!ID_PATTERN.test(slug)) throw new Error(`sections.json：页面名 ${slug} 无效`)
    return section
  })
}

async function listPageFiles() {
  const pages = []
  for (const entry of await readdir(path.join(repositoryRoot, siteRoot), { withFileTypes: true })) {
    if (!entry.isDirectory() || SITE_DIRECTORIES.has(entry.name)) continue
    for (const file of await readdir(path.join(repositoryRoot, siteRoot, entry.name))) {
      if (file.endsWith('.md')) pages.push(`${entry.name}/${file.slice(0, -3)}`)
    }
  }
  return pages.sort()
}

/** Reads every page, then resolves links against the whole set; collects all problems instead of stopping at one. */
export async function readSite({ commit = 'main' } = {}) {
  const errors = []
  const sections = await readSections()
  const listed = sections.flatMap((section) => section.pages.map((slug) => `${section.id}/${slug}`))
  const files = await listPageFiles()
  for (const id of files) if (!listed.includes(id)) errors.push(`${siteRoot}/${id}.md 没有列在 sections.json 里`)
  for (const id of listed) if (!files.includes(id)) errors.push(`sections.json 列出的 ${id} 没有对应文件`)

  const pages = new Map()
  for (const id of listed.filter((entry) => files.includes(entry))) {
    const file = `${siteRoot}/${id}.md`
    try {
      const { fields, body } = parseFrontMatter(await readFile(path.join(repositoryRoot, file), 'utf8'), file)
      const lines = body.replace(/^\n+/u, '').split('\n')
      const title = lines[0].match(/^# (.+)$/u)?.[1]
      if (title === undefined) throw new Error(`${file}：页面头部之后第一行必须是 # 标题`)
      const markdownLines = lines.slice(1)
      while (markdownLines[0] === '') markdownLines.shift()
      const counts = new Map([[headingAnchor(plainHeading(title), new Map()), 1]])
      const anchors = new Set()
      const headings = []
      for (const [, line] of proseLines(markdownLines)) {
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/u)
        if (!heading) continue
        const text = plainHeading(heading[2])
        const anchor = headingAnchor(text, counts)
        // Only ## and ### get anchors on the site, so only they can be linked to.
        if (heading[1].length === 2 || heading[1].length === 3) anchors.add(anchor)
        if (heading[1].length === 1) errors.push(`${file}：正文里不能再有 # 一级标题「${text}」`)
        if (heading[1].length === 2 || heading[1].length === 3)
          headings.push({ depth: heading[1].length, text, anchor })
      }
      const flowShots = fields.flow === undefined ? undefined : await readFlowShots(fields.flow)
      if (flowShots === null) errors.push(`${file}：flow 指向的 ${siteRoot}/flows/${fields.flow}.flow.ts 不存在`)
      pages.set(id, {
        id,
        file,
        section: id.split('/')[0],
        title,
        fields,
        markdownLines,
        headings,
        anchors,
        flowShots: flowShots ?? new Set(),
        shots: new Set(),
        terms: quotedTerms(markdownLines),
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  // Shots from every flow land in one directory, so their names must not collide.
  const flowsDir = path.join(repositoryRoot, siteRoot, 'flows')
  const shotOwners = new Map()
  for (const file of existsSync(flowsDir) ? await readdir(flowsDir) : []) {
    if (!file.endsWith('.flow.ts')) continue
    for (const name of (await readFlowShots(file.slice(0, -8))) ?? []) {
      if (shotOwners.has(name)) errors.push(`截图名 ${name} 同时出现在 ${shotOwners.get(name)} 和 ${file}`)
      shotOwners.set(name, file)
    }
  }

  // The help button opens one page per interface route, so a route belongs to exactly one page.
  const routeOwners = new Map()
  for (const page of pages.values())
    for (const route of page.fields.routes) {
      if (!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u.test(route))
        errors.push(`${page.file}：routes 里的 ${route} 不是界面路由`)
      else if (routeOwners.has(route)) errors.push(`${page.file}：路由 ${route} 已经属于 ${routeOwners.get(route)}`)
      else routeOwners.set(route, page.id)
    }

  const assets = new Map()
  const addAsset = (file) => {
    const extension = path.extname(file).toLowerCase()
    const name = `${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)}${extension}`
    assets.set(name, file)
    return `${ASSET_ORIGIN}/${name}`
  }
  const resolveLink = (page, href, isImage) => {
    if (isImage && href.startsWith('shot:')) {
      const name = href.slice(5)
      if (page.fields.flow === undefined) errors.push(`${page.file}：用了截图 ${href}，但页面头部没有 flow`)
      else if (!page.flowShots.has(name)) errors.push(`${page.file}：流程 ${page.fields.flow} 里没有截图 ${name}`)
      page.shots.add(name)
      return href
    }
    if (isImage && href.startsWith('media:')) {
      const name = href.slice(6)
      const file = MEDIA_EXTENSIONS.map((extension) =>
        path.join(repositoryRoot, siteRoot, 'media', `${name}${extension}`),
      ).find((candidate) => existsSync(candidate))
      if (file === undefined) {
        errors.push(`${page.file}：${siteRoot}/media/ 里没有效果图 ${name}`)
        return href
      }
      return addAsset(file)
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('#')) return href
    const [target, hash] = href.split('#')
    const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), decodeURIComponent(target)))
    if (repoPath.startsWith('..') || !existsSync(path.join(repositoryRoot, repoPath))) {
      errors.push(`${page.file}：链接目标不存在 ${href}`)
      return href
    }
    if (isImage) {
      const extension = path.extname(repoPath).toLowerCase()
      if (!(extension in IMAGE_TYPES)) {
        errors.push(`${page.file}：不支持的图片格式 ${href}`)
        return href
      }
      return addAsset(path.join(repositoryRoot, repoPath))
    }
    if (repoPath.startsWith(`${siteRoot}/`) && repoPath.endsWith('.md') && repoPath !== readmePath) {
      const linked = pages.get(repoPath.slice(siteRoot.length + 1, -3))
      if (linked === undefined) {
        errors.push(`${page.file}：链接的页面没有列在 sections.json 里 ${href}`)
        return href
      }
      if (hash !== undefined && !linked.anchors.has(decodeURIComponent(hash))) {
        errors.push(`${page.file}：${linked.file} 没有小节 #${hash}`)
      }
      return `/docs/${linked.id}${hash !== undefined ? `#${hash}` : ''}`
    }
    const kind = statSync(path.join(repositoryRoot, repoPath)).isDirectory() ? 'tree' : 'blob'
    return `${REPOSITORY_URL}/${kind}/${commit}/${repoPath}${hash !== undefined ? `#${hash}` : ''}`
  }

  for (const page of pages.values()) {
    const lines = [...page.markdownLines]
    for (const [index, line] of proseLines(page.markdownLines)) {
      lines[index] = line.replace(
        /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/gu,
        (_match, bang, text, href, title) => `${bang}[${text}](${resolveLink(page, href, bang === '!')}${title})`,
      )
    }
    page.markdown = `${lines.join('\n').trim()}\n`
  }
  return { sections, pages, assets, errors }
}

/** Every https://nxt.nekro.ai/docs/<section>/<page> link in product source, scripts and workflows must name a page and section that exist. */
async function checkCodeLinks(pages) {
  const errors = []
  const sources = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'apps/*/src',
      'packages/*/src',
      'scripts',
      '.github/workflows',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((file) => /\.(?:ts|tsx|mjs|js|yml)$/u.test(file))
  for (const file of sources) {
    const text = await readFile(path.join(repositoryRoot, file), 'utf8')
    for (const match of text.matchAll(
      /https:\/\/nxt\.nekro\.ai\/docs\/([a-z0-9-]+\/[a-z0-9-]+)(?:#([^'"`\s)<]+))?/gu,
    )) {
      const page = pages.get(match[1])
      if (page === undefined) errors.push(`${file}：文档链接指向不存在的页面 ${match[1]}`)
      else if (match[2] !== undefined && !page.anchors.has(decodeURIComponent(match[2]))) {
        errors.push(`${file}：${match[1]} 没有小节 #${match[2]}`)
      }
    }
  }
  return errors
}

const SDK_SOURCE = 'packages/extension-sdk/src/index.ts'
const SDK_PAGE = 'develop/sdk'

/** Members declared directly in one `export interface Name {` block (or a nested `readonly name: {` block). */
const interfaceMembers = (source, opening, indent) => {
  const start = source.indexOf(opening)
  if (start < 0) return null
  const members = []
  for (const line of source.slice(start + opening.length).split('\n')) {
    if (line.startsWith(`${' '.repeat(indent - 2)}}`)) break
    const member = line.match(new RegExp(`^ {${indent}}(?:readonly )?([a-zA-Z]+)\\??[:(<]`, 'u'))
    if (member) members.push(member[1])
  }
  return members
}

/**
 * The SDK reference is written by hand, so this keeps it from falling behind: every host capability and harness method
 * the SDK declares has to appear in the page as code.
 */
async function checkSdkReference(pages) {
  const page = pages.get(SDK_PAGE)
  if (page === undefined) return []
  const source = await readFile(path.join(repositoryRoot, SDK_SOURCE), 'utf8')
  const surface = [
    interfaceMembers(source, 'export interface NxtHostService {', 2),
    interfaceMembers(source, 'export interface NxtHostLayerService {', 2),
    interfaceMembers(source, '  readonly harness: {', 4),
  ]
  if (surface.some((members) => members === null || members.length === 0))
    return [`${SDK_SOURCE}：找不到 NxtHostService、NxtHostLayerService 或 harness，更新 checkSdkReference`]
  const missing = [...new Set(surface.flat())].filter((name) => !page.markdown.includes(`\`${name}\``))
  return missing.length === 0
    ? []
    : [`${page.file}：SDK 新增的 ${missing.map((name) => `\`${name}\``).join('、')} 还没有写进参考`]
}

export function renderReadme(sections, pages) {
  const lines = [
    '# NekroNXT 使用文档',
    '',
    `这里是使用文档的原文，发布在 [${DOCS_ORIGIN}/docs](${DOCS_ORIGIN}/docs)。栏目、页面头部和发布方式见[文档包格式](BUNDLE.md)。`,
    '',
    '<!-- 本文件由 node scripts/docs-bundle.mjs readme 生成，不要手改。 -->',
  ]
  for (const section of sections) {
    const entries = section.pages.map((slug) => pages.get(`${section.id}/${slug}`)).filter(Boolean)
    if (entries.length === 0) continue
    lines.push('', `## ${section.title}`, '')
    for (const page of entries) lines.push(`- [${page.title}](${page.id}.md)：${page.fields.summary}`)
  }
  return `${lines.join('\n')}\n`
}

/** The previous bundle's shots, kept for pages whose flow failed this time. */
async function previousShots(channel) {
  try {
    const manifest = /** @type {{ bundle: string }} */ (
      await (await globalThis.fetch(`${DIST_ORIGIN}/${channel}/manifest.json`)).json()
    )
    const bundle = /** @type {{ shots?: Record<string, unknown> }} */ (
      await (await globalThis.fetch(`${DIST_ORIGIN}/${channel}/${manifest.bundle}`)).json()
    )
    return bundle.shots ?? {}
  } catch (error) {
    console.warn(
      `读取上一版文档包失败，流程失败的截图不会保留：${error instanceof Error ? error.message : String(error)}`,
    )
    return {}
  }
}

/**
 * Turns the reports `pnpm docs:shots` wrote into shots and stale pages. A page is stale when its flow failed or the
 * interface no longer shows a word the page quotes in 「」; its shots then fall back to the previous bundle's.
 */
export function applyFlows(site, reportsDir, previous) {
  const reports = new Map()
  const stale = new Map()
  const shots = {}
  const missing = []
  const flagged = (page, reason) => stale.set(page.id, [...(stale.get(page.id) ?? []), reason])
  for (const page of site.pages.values()) {
    const flow = page.fields.flow
    if (flow === undefined) continue
    if (!reports.has(flow)) {
      const file = path.join(reportsDir, `${flow}.json`)
      reports.set(flow, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)
    }
    const report = reports.get(flow)
    if (report === null) flagged(page, `流程 ${flow} 没有运行`)
    else if (report.status !== 'passed') flagged(page, `流程 ${flow} 失败：${report.error ?? report.status}`)
    else {
      const absent = page.terms.filter((term) => !report.texts.some((text) => text.includes(term)))
      if (absent.length > 0) flagged(page, `界面上没有出现 ${absent.map((term) => `「${term}」`).join('、')}`)
    }
    for (const name of page.shots) {
      const fresh = report?.status === 'passed' ? report.shots[name] : undefined
      const light = path.join(reportsDir, `${name}.light.webp`)
      const dark = path.join(reportsDir, `${name}.dark.webp`)
      if (fresh !== undefined && existsSync(light) && existsSync(dark)) {
        const url = (file) => {
          const asset = `${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)}.webp`
          site.assets.set(asset, file)
          return `${ASSET_ORIGIN}/${asset}`
        }
        shots[name] = { light: url(light), dark: url(dark), width: fresh.width, height: fresh.height }
      } else if (previous[name] !== undefined) shots[name] = previous[name]
      else missing.push(`${page.file}：截图 ${name} 没有生成，上一版也没有`)
    }
  }
  return { shots, stale, missing }
}

/** The help button's table: the deepest matching route wins, so longer routes come first. */
export function renderRoutes(pages) {
  const routes = [...pages.values()]
    .flatMap((page) => page.fields.routes.map((route) => [route, page.id]))
    .sort(([a], [b]) => b.split('/').length - a.split('/').length || a.localeCompare(b))
  return [
    '// 由 node scripts/docs-bundle.mjs readme 按使用文档页面头部的 routes 生成，不要手改。',
    '',
    '/** Interface routes and the documentation page the help button opens there; deeper routes first. */',
    'export const DOCS_ROUTES: readonly (readonly [route: string, page: string])[] = [',
    ...routes.map(([route, id]) => `  ['${route}', '${id}'],`),
    ']',
    '',
  ].join('\n')
}

export function bundleOf({ sections, pages }, release, builtAt, { shots = {}, stale = new Map() } = {}) {
  return {
    schemaVersion: 1,
    channel: release.channel,
    version: release.version,
    commit: release.commit,
    builtAt,
    sections: sections
      .map((section) => ({
        id: section.id,
        title: section.title,
        pages: section.pages.map((slug) => `${section.id}/${slug}`),
      }))
      .filter((section) => section.pages.length > 0),
    shots,
    pages: [...pages.values()].map((page) => ({
      id: page.id,
      section: page.section,
      title: page.title,
      summary: page.fields.summary,
      ...(page.fields.since === undefined ? {} : { since: page.fields.since }),
      ui: page.fields.ui,
      routes: page.fields.routes,
      keywords: page.fields.keywords,
      stale: stale.has(page.id),
      markdown: page.markdown,
      headings: page.headings,
    })),
  }
}

const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** Stable releases pass --strict: any stale page or missing shot fails the build instead of shipping a warning. */
async function build(channel, out, { shotsDir, strict }) {
  const release = await readProductRelease(repositoryRoot, channel)
  const site = await readSite({ commit: release.commit })
  if (site.errors.length > 0) throw new Error(site.errors.join('\n'))
  const flows = applyFlows(site, shotsDir, await previousShots(channel))
  const problems = [...[...flows.stale].map(([id, reasons]) => `${id} 待更新：${reasons.join('；')}`), ...flows.missing]
  if (problems.length > 0) {
    const message = ['文档流程有问题：', ...problems.map((problem) => `  - ${problem}`)].join('\n')
    if (strict) throw new Error(message)
    console.warn(message)
  }
  const bundle = JSON.stringify(bundleOf(site, release, new Date().toISOString(), flows))
  const digest = createHash('sha256').update(bundle).digest('hex')
  await rm(out, { recursive: true, force: true })
  await mkdir(path.join(out, 'bundles'), { recursive: true })
  await mkdir(path.join(out, 'assets'), { recursive: true })
  await writeFile(path.join(out, 'bundles', `${digest}.json`), bundle)
  for (const [name, source] of site.assets) await writeFile(path.join(out, 'assets', name), await readFile(source))
  const manifest = {
    schemaVersion: 1,
    channel,
    version: release.version,
    commit: release.commit,
    builtAt: JSON.parse(bundle).builtAt,
    bundle: `bundles/${digest}.json`,
  }
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `文档包 ${release.version}：${site.pages.size} 页、${site.assets.size} 张图片、${flows.stale.size} 页待更新 → ${path.relative(repositoryRoot, out)}`,
  )
}

/** Assets and the bundle are content-addressed and uploaded first; the manifest switches readers over last. */
async function upload(channel, out) {
  const account = process.env['R2_ACCOUNT_ID']
  if (!account) throw new Error('缺少 R2_ACCOUNT_ID')
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'))
  if (manifest.channel !== channel) throw new Error(`${out} 是 ${manifest.channel} 的文档包，不是 ${channel}`)
  const { bucket, aws } = r2Aws(account)
  const exists = (key) => {
    try {
      aws(['s3api', 'head-object', '--bucket', bucket, '--key', key])
      return true
    } catch {
      return false
    }
  }
  const put = (file, key, type, cache) =>
    retrying(key, () =>
      aws([
        's3',
        'cp',
        file,
        `s3://${bucket}/${key}`,
        '--content-type',
        type,
        '--cache-control',
        cache,
        '--only-show-errors',
      ]),
    )
  const immutable = 'public, max-age=31536000, immutable'
  for (const name of await readdir(path.join(out, 'assets'))) {
    const key = `nxt/docs/assets/${name}`
    if (!exists(key)) put(path.join(out, 'assets', name), key, IMAGE_TYPES[path.extname(name)], immutable)
  }
  put(path.join(out, manifest.bundle), `nxt/docs/${channel}/${manifest.bundle}`, 'application/json', immutable)
  put(path.join(out, 'manifest.json'), `nxt/docs/${channel}/manifest.json`, 'application/json', 'public, max-age=60')
  console.log(`已发布 ${channel} 文档 ${manifest.version}`)
}

async function main() {
  const [command, channel] = process.argv.slice(2)
  const out = path.resolve(repositoryRoot, option('--out', '.local/docs-bundle'))
  if (command === 'check') {
    const site = await readSite()
    const errors = [...site.errors]
    if (errors.length === 0) {
      errors.push(...(await checkCodeLinks(site.pages)))
      errors.push(...(await checkSdkReference(site.pages)))
      const current = await readFile(path.join(repositoryRoot, readmePath), 'utf8').catch(() => '')
      if (current !== renderReadme(site.sections, site.pages))
        errors.push(`${readmePath} 已过期，运行 node scripts/docs-bundle.mjs readme`)
      const routes = await readFile(path.join(repositoryRoot, routesPath), 'utf8').catch(() => '')
      if (routes !== renderRoutes(site.pages))
        errors.push(`${routesPath} 已过期，运行 node scripts/docs-bundle.mjs readme`)
    }
    if (errors.length > 0) {
      console.error(['使用文档检查失败：', ...errors.map((error) => `  - ${error}`)].join('\n'))
      process.exit(1)
    }
    console.log(`使用文档：${site.pages.size} 页检查通过`)
  } else if (command === 'readme') {
    const site = await readSite()
    if (site.errors.length > 0) throw new Error(site.errors.join('\n'))
    await writeFile(path.join(repositoryRoot, readmePath), renderReadme(site.sections, site.pages))
    await writeFile(path.join(repositoryRoot, routesPath), renderRoutes(site.pages))
  } else if ((command === 'build' || command === 'upload') && (channel === 'stable' || channel === 'preview')) {
    if (command === 'upload') await upload(channel, out)
    else
      await build(channel, out, {
        shotsDir: path.resolve(repositoryRoot, option('--shots', '.local/docs-shots')),
        strict: process.argv.includes('--strict'),
      })
  } else {
    throw new Error(
      '用法：docs-bundle.mjs check | readme | build <stable|preview> [--shots 目录] [--strict] | upload <stable|preview> [--out 目录]',
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
