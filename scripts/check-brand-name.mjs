import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = process.cwd()
const failures = []

const collectMarkdown = async (directory) => {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.local' ||
      entry.name === 'data' ||
      entry.name === 'dist' ||
      entry.name === 'release' ||
      entry.name === 'coverage' ||
      entry.name === 'playwright-report' ||
      entry.name === 'test-results'
    ) {
      continue
    }
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(repositoryRoot, absolute)
    if (relative.startsWith('docs/archive/')) continue
    if (entry.isDirectory()) result.push(...(await collectMarkdown(absolute)))
    else if (entry.name.endsWith('.md')) result.push(absolute)
  }
  return result
}

const visibleMarkdown = (source) => {
  let fenced = false
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        fenced = !fenced
        return ''
      }
      if (fenced) return ''
      return line.replace(/`[^`]*`/gu, '').replace(/\]\([^)]*\)/gu, ']()')
    })
    .join('\n')
}

for (const file of await collectMarkdown(repositoryRoot)) {
  const source = await readFile(file, 'utf8')
  const visible = visibleMarkdown(source)
  const lines = visible.split('\n')
  lines.forEach((line, index) => {
    if (line.includes('NekroNxt')) {
      failures.push(`${path.relative(repositoryRoot, file)}:${index + 1} 公开文案必须写 NekroNXT 或 NXT`)
    }
  })
}

const userVisibleSources = [
  'apps/web/index.html',
  'apps/web/public/site.webmanifest',
  'apps/web/src/app.tsx',
  'apps/web/src/http-host.ts',
  'apps/web/src/product-store.ts',
  'apps/web/src/pages/channel-page.tsx',
  'apps/web/src/pages/channel-trajectory.tsx',
  'apps/web/src/pages/connections-page.tsx',
  'apps/web/src/pages/extensions-runtime-pages.tsx',
  'apps/web/src/shell/object-pane.tsx',
  'apps/desktop/src/main.ts',
  'apps/desktop/src/instance-manager.ts',
  'scripts/rolling-preview-release.mjs',
  'packages/adapter-web/src/index.ts',
]
for (const relative of userVisibleSources) {
  const source = await readFile(path.join(repositoryRoot, relative), 'utf8')
  source.split('\n').forEach((line, index) => {
    const quotedLegacy = /(['"`])[^'"`]*NekroNxt[^'"`]*\1/u.test(line)
    const jsxLegacy = />[^<]*NekroNxt[^<]*</u.test(line)
    if (quotedLegacy || jsxLegacy) failures.push(`${relative}:${index + 1} 用户可见字符串仍包含 NekroNxt`)
  })
}

const distributions = JSON.parse(await readFile(path.join(repositoryRoot, 'apps/desktop/distributions.json'), 'utf8'))
if (distributions.stable?.productName !== 'NekroNXT') failures.push('Desktop stable productName 必须为 NekroNXT')
if (distributions.preview?.productName !== 'NekroNXT Preview') {
  failures.push('Desktop preview productName 必须为 NekroNXT Preview')
}
if (distributions.stable?.appUserDataName !== 'NekroNxt') failures.push('stable 数据目录兼容名不得改变')
if (distributions.preview?.appUserDataName !== 'NekroNxt Preview') failures.push('preview 数据目录兼容名不得改变')

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log('品牌展示名检查通过。')
}
