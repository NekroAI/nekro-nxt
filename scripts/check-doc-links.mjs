import { execFileSync } from 'node:child_process'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const realRoot = await realpath(root)
const rootDocument = 'AGENTS.md'
const optionalLocalIndex = '.local/README.md'
// Only these directories own unlinked local knowledge; runtime trees are never enumerated.
const maintainedLocalDirectories = ['.local/docs', '.local/brand-design']
const errors = []

const toRepositoryPath = (file) => path.relative(root, file).split(path.sep).join('/')

const exists = async (target) => {
  try {
    return await stat(target)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return undefined
    }
    throw error
  }
}

async function collectMarkdown(target) {
  const info = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined || info.isSymbolicLink()) return []
  if (info.isFile()) return target.endsWith('.md') ? [target] : []
  if (!info.isDirectory()) return []
  const names = await readdir(target, { withFileTypes: true })
  const nested = await Promise.all(names.map((entry) => collectMarkdown(path.join(target, entry.name))))
  return nested.flat()
}

const isPrivatePath = (file) =>
  file === '.local' ||
  file.startsWith('.local/') ||
  file === 'docs-private' ||
  file.startsWith('docs-private/') ||
  (!file.includes('/') && file.endsWith('.local.md'))
const isRepositoryPath = (file) => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file)

const publicDocumentCandidates = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)

const publicDocuments = new Set()
for (const file of publicDocumentCandidates) {
  if ((await exists(path.join(root, file)))?.isFile()) publicDocuments.add(file)
}
const localDocuments = new Set(
  (await Promise.all(maintainedLocalDirectories.map((directory) => collectMarkdown(path.join(root, directory)))))
    .flat()
    .map(toRepositoryPath)
    .filter((file) => !publicDocuments.has(file)),
)
if ((await exists(path.join(root, optionalLocalIndex)))?.isFile() && !publicDocuments.has(optionalLocalIndex)) {
  localDocuments.add(optionalLocalIndex)
}
const documentPaths = new Set([...publicDocuments, ...localDocuments])
const graph = new Map()

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
  graph.set(source, new Set())

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    // shot: and media: are user-documentation images; scripts/docs-bundle.mjs checks them.
    if (/^(?:https?:|mailto:|data:|shot:|media:)/u.test(raw)) continue
    const [targetPart, fragment] = raw.split('#', 2)
    const decodedTarget = decodeTarget(targetPart ?? '')
    const target = decodedTarget ? path.resolve(path.dirname(file), decodedTarget) : file
    const targetPath = toRepositoryPath(target)
    const info = await exists(target)
    const optionalIndexLink = isOptionalMissingLocalIndex(source, target) && !fragment
    const privateTarget =
      isPrivatePath(targetPath) || (info?.isFile() && targetPath.endsWith('.md') && !publicDocuments.has(targetPath))
    if (publicDocuments.has(source) && privateTarget && !optionalIndexLink) {
      errors.push(`${source}: 公开文档只能由根 AGENTS.md 链接本地私有索引，不能链接 ${targetPath}`)
      continue
    }
    if (info === undefined) {
      if (!optionalIndexLink) errors.push(`${source}: 找不到链接目标 ${raw}`)
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
    // Explicit Markdown links opt local files into maintenance, even outside the knowledge directories.
    // Directory and asset links only validate their target; they never trigger a recursive scan.
    // Resolve symlinks before enrollment so external references only validate target and fragment.
    if (
      localDocuments.has(source) &&
      info.isFile() &&
      targetPath.endsWith('.md') &&
      isRepositoryPath(targetPath) &&
      !publicDocuments.has(targetPath) &&
      isRepositoryPath(
        path
          .relative(realRoot, await realpath(target))
          .split(path.sep)
          .join('/'),
      )
    ) {
      localDocuments.add(targetPath)
      documentPaths.add(targetPath)
    }
    if (documentPaths.has(targetPath)) graph.get(source).add(targetPath)
  }
}

function findReachable(start, allowed) {
  const reachable = new Set()
  const pending = [start]
  while (pending.length > 0) {
    const source = pending.pop()
    if (source === undefined || reachable.has(source) || !allowed.has(source)) continue
    reachable.add(source)
    for (const target of graph.get(source) ?? []) pending.push(target)
  }
  return reachable
}

// Private links cannot make public documents reachable, or bypass the private index.
const reachablePublic = findReachable(rootDocument, publicDocuments)
const reachableLocal = graph.get(rootDocument)?.has(optionalLocalIndex)
  ? findReachable(optionalLocalIndex, localDocuments)
  : new Set()
if (!publicDocuments.has(rootDocument)) errors.push('找不到公开文档根 AGENTS.md')
const unreachablePublic = [...publicDocuments].filter((file) => !reachablePublic.has(file)).sort()
const unreachableLocal = [...localDocuments].filter((file) => !reachableLocal.has(file)).sort()
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
    `Documentation graph check passed (${publicDocuments.size} public files, ${localDocuments.size} local files).`,
  )
}
