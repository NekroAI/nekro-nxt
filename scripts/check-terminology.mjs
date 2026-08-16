import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const targets = ['prototype', 'apps']
const forbidden = [
  ['英文实体名 Agents', /["'`>]Agents(?:["'`<\s])/g],
  ['QQ Bot', /QQ Bot/g],
  ['以 Bot 身份', /以 Bot 身份/g],
  ['网页摘要助手', /网页摘要助手/g],
  ['保存为本地插件', /保存为本地插件/g],
  ['创造模式', /创造模式/g],
]

async function filesUnder(relative) {
  const absolute = path.join(root, relative)
  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const output = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(child)))
    else if (/\.(?:html|js|jsx|ts|tsx|json|css)$/.test(entry.name)) output.push(child)
  }
  return output
}

const errors = []
for (const file of (await Promise.all(targets.map(filesUnder))).flat()) {
  const content = await readFile(path.join(root, file), 'utf8')
  for (const [label, pattern] of forbidden) {
    pattern.lastIndex = 0
    if (pattern.test(content)) errors.push(`${file}: 发现用户可见旧称“${label}”`)
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('User-facing terminology check passed.')
}
