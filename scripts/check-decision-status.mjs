import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const decisionRoot = path.join(root, 'docs', 'decisions')
const expected = new Map([
  ['proposed', 'proposed'],
  ['accepted', 'accepted'],
  ['implemented', 'implemented'],
  ['rejected', 'rejected'],
])

const errors = []
const isNodeError = (error, code) => error instanceof Error && 'code' in error && error.code === code

for (const [directory, status] of expected) {
  const absolute = path.join(decisionRoot, directory)
  let names = []
  try {
    names = await readdir(absolute)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) continue
    throw error
  }

  for (const name of names.filter((entry) => entry.endsWith('.md'))) {
    const file = path.join(absolute, name)
    const content = await readFile(file, 'utf8')
    const match = content.match(/^状态：([^\s（]+)/m)
    if (!match) {
      errors.push(`${path.relative(root, file)}: 缺少“状态：”行`)
      continue
    }
    if (match[1] !== status) {
      errors.push(`${path.relative(root, file)}: 目录要求 ${status}，实际为 ${match[1]}`)
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Decision status check passed.')
}
