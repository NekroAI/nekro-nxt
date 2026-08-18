import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const webSource = path.join(root, 'apps/web/src')
const write = process.argv.includes('--write')

async function cssFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await cssFiles(target)))
    else if (entry.name.endsWith('.css')) files.push(target)
  }
  return files
}

const declaration = (source) => {
  const names = new Set()
  for (const match of source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)) names.add(match[1])
  const properties = [...names]
    .sort()
    .map((name) => `  readonly ${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name)}: string`)
    .join('\n')
  return `declare const styles: {\n${properties}\n}\n\nexport default styles\n`
}

const declarationPath = (cssFile) => `${cssFile.slice(0, -'.css'.length)}.d.css.ts`

const mismatches = []
for (const cssFile of await cssFiles(webSource)) {
  const target = declarationPath(cssFile)
  const legacyTarget = `${cssFile}.d.ts`
  const expected = cssFile.endsWith('.module.css') ? declaration(await readFile(cssFile, 'utf8')) : 'export {}\n'
  if (write) {
    await writeFile(target, expected)
    await unlink(legacyTarget).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    continue
  }
  const actual = await readFile(target, 'utf8').catch(() => '')
  if (actual !== expected) mismatches.push(path.relative(root, target))
}

if (mismatches.length > 0) {
  throw new Error(`CSS Module 类型生成物已漂移：${mismatches.join(', ')}；请运行 pnpm generate:css-types。`)
}
console.log(write ? 'CSS Module types generated.' : 'CSS Module type check passed.')
