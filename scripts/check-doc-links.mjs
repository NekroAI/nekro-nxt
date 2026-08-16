import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const roots = ['README.md', 'AGENTS.md', 'docs']
const errors = []

async function collect(target) {
  const absolute = path.join(root, target)
  const info = await stat(absolute)
  if (info.isFile()) return [absolute]
  const names = await readdir(absolute, { withFileTypes: true })
  const nested = await Promise.all(
    names.filter((entry) => !entry.name.startsWith('.')).map((entry) => collect(path.join(target, entry.name))),
  )
  return nested.flat()
}

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

const files = (await Promise.all(roots.map(collect))).flat().filter((file) => file.endsWith('.md'))

for (const file of files) {
  const content = await readFile(file, 'utf8')
  const inlineDocumentPaths = content.matchAll(/`(docs\/[^`\n]+\.md)`/g)
  for (const match of inlineDocumentPaths) {
    const target = path.resolve(root, match[1])
    try {
      const info = await stat(target)
      if (!info.isFile()) errors.push(`${path.relative(root, file)}: 行内文档路径不是文件 ${match[1]}`)
    } catch {
      errors.push(`${path.relative(root, file)}: 找不到行内文档路径 ${match[1]}`)
    }
  }
  const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)
  for (const match of links) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|data:)/.test(raw)) continue
    const [targetPart, fragment] = raw.split('#', 2)
    const target = targetPart ? path.resolve(path.dirname(file), decodeURIComponent(targetPart)) : file
    let targetContent
    try {
      const info = await stat(target)
      if (!info.isFile() && fragment) {
        errors.push(`${path.relative(root, file)}: 目录链接不能带 fragment：${raw}`)
        continue
      }
      if (info.isFile() && fragment) targetContent = await readFile(target, 'utf8')
    } catch {
      errors.push(`${path.relative(root, file)}: 找不到链接目标 ${raw}`)
      continue
    }
    if (fragment && targetContent !== undefined) {
      const wanted = decodeURIComponent(fragment).toLowerCase()
      if (!headingSlugs(targetContent).has(wanted)) {
        errors.push(`${path.relative(root, file)}: 找不到标题 #${fragment}（${raw}）`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation link check passed (${files.length} files).`)
}
