import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const rootDocument = 'AGENTS.md'
const optionalLocalIndex = '.local/README.md'
const errors = []

const toRepositoryPath = (file) => path.relative(root, file).split(path.sep).join('/')

const exists = async (target) => {
  try {
    return await stat(target)
  } catch {
    return undefined
  }
}

async function collectMarkdown(target) {
  const info = await exists(target)
  if (info === undefined) return []
  if (info.isFile()) return target.endsWith('.md') ? [target] : []
  const names = await readdir(target, { withFileTypes: true })
  const nested = await Promise.all(
    names
      .filter((entry) => !entry.name.startsWith('.') || entry.name === '.local')
      .map((entry) => collectMarkdown(path.join(target, entry.name))),
  )
  return nested.flat()
}

const isGeneratedLocalDocument = (relativePath) =>
  relativePath.startsWith('.local/playwright-') || relativePath.startsWith('.local/coverage/')

const trackedDocuments = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const ignoredDocumentCandidates = [
  ...(await collectMarkdown(path.join(root, '.local'))),
  ...(await collectMarkdown(path.join(root, 'docs-private'))),
  ...(await readdir(root, { withFileTypes: true })).flatMap((entry) =>
    entry.isFile() && entry.name.endsWith('.local.md') ? [path.join(root, entry.name)] : [],
  ),
]
const localDocuments = [...new Set(ignoredDocumentCandidates.map(toRepositoryPath))]
  .filter((file) => !trackedDocuments.includes(file) && !isGeneratedLocalDocument(file))
  .sort()
const documentPaths = new Set([...trackedDocuments, ...localDocuments])
const graph = new Map([...documentPaths].map((file) => [file, new Set()]))

function headingSlugs(markdown) {
  const counts = new Map()
  const slugs = new Set()
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    if (!heading) continue
    const base = heading[1]
      .replace(/<[^>]+>/g, '')
      .replace(/[\p{P}\p{S}]/gu, (character) => (character === '-' || character === '_' ? character : ''))
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    slugs.add(count === 0 ? base : `${base}-${count}`)
  }
  return slugs
}

const decodeTarget = (raw) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const isOptionalMissingLocalIndex = (source, target) =>
  source === rootDocument && toRepositoryPath(target) === optionalLocalIndex

for (const source of documentPaths) {
  const file = path.join(root, source)
  const content = await readFile(file, 'utf8')

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|data:)/u.test(raw)) continue
    const [targetPart, fragment] = raw.split('#', 2)
    const decodedTarget = decodeTarget(targetPart ?? '')
    const target = decodedTarget ? path.resolve(path.dirname(file), decodedTarget) : file
    const targetPath = toRepositoryPath(target)
    const info = await exists(target)
    if (info === undefined) {
      if (!isOptionalMissingLocalIndex(source, target)) errors.push(`${source}: 找不到链接目标 ${raw}`)
      continue
    }
    if (!info.isFile() && fragment) {
      errors.push(`${source}: 目录链接不能带 fragment：${raw}`)
      continue
    }
    if (info.isFile() && fragment) {
      const targetContent = await readFile(target, 'utf8')
      const wanted = decodeTarget(fragment).toLowerCase()
      if (!headingSlugs(targetContent).has(wanted)) errors.push(`${source}: 找不到标题 #${fragment}（${raw}）`)
    }
    if (documentPaths.has(targetPath)) graph.get(source)?.add(targetPath)
    if (trackedDocuments.includes(source) && targetPath.startsWith('.local/')) {
      if (source !== rootDocument || targetPath !== optionalLocalIndex) {
        errors.push(`${source}: 公开文档只能由根 AGENTS.md 链接本地私有索引，不能链接 ${targetPath}`)
      }
    }
  }
}

const reachable = new Set()
const pending = [rootDocument]
while (pending.length > 0) {
  const source = pending.pop()
  if (source === undefined || reachable.has(source)) continue
  reachable.add(source)
  for (const target of graph.get(source) ?? []) pending.push(target)
}

const unreachablePublic = trackedDocuments.filter((file) => !reachable.has(file))
const unreachableLocal = localDocuments.filter((file) => !reachable.has(file))
if (unreachablePublic.length > 0) {
  errors.push(
    ['以下公开文档无法从 AGENTS.md 沿引用链到达：', ...unreachablePublic.map((file) => `  - ${file}`)].join('\n'),
  )
}
if (unreachableLocal.length > 0) {
  errors.push(
    [
      '以下本地文档无法从 AGENTS.md 经 .local/README.md 沿引用链到达：',
      ...unreachableLocal.map((file) => `  - ${file}`),
    ].join('\n'),
  )
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  console.error('请把文档接入最近的领域索引；不要把全部文件平铺到 AGENTS.md。')
  process.exitCode = 1
} else {
  console.log(
    `Documentation graph check passed (${trackedDocuments.length} public files, ${localDocuments.length} local files).`,
  )
}
