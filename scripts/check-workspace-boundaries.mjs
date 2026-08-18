import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

import { compareCounts, countsFromFindings, readBaseline, writeBaseline } from './lib/quality-baseline.mjs'

const root = process.cwd()
const baselinePath = 'scripts/baselines/workspace-boundaries.json'
const findings = []
const isNodeError = (error, code) => error instanceof Error && 'code' in error && error.code === code

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function report(rule, file, message) {
  findings.push({ rule, file: relative(file), message })
}

async function workspaceProjects() {
  const projects = []
  for (const group of ['apps', 'packages']) {
    const groupRoot = path.join(root, group)
    for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(groupRoot, entry.name)
      const manifestPath = path.join(directory, 'package.json')
      const tsconfigPath = path.join(directory, 'tsconfig.json')
      try {
        const [manifest, tsconfig] = await Promise.all([readJson(manifestPath), readJson(tsconfigPath)])
        projects.push({ group, directory, manifestPath, tsconfigPath, manifest, tsconfig })
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }
  return projects.sort((left, right) => left.directory.localeCompare(right.directory))
}

async function sourceFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['dist', 'lib', 'node_modules'].includes(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await sourceFiles(target)))
    else if (/\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) result.push(target)
  }
  return result
}

function referencedProjectDirectories(project) {
  return new Set(
    (project.tsconfig.references ?? []).map((reference) =>
      path.resolve(project.directory, reference.path).split(path.sep).join('/'),
    ),
  )
}

const projects = await workspaceProjects()
const byName = new Map()
const byDirectory = new Map(projects.map((project) => [project.directory.split(path.sep).join('/'), project]))
for (const project of projects) {
  if (typeof project.manifest.name !== 'string') {
    report('invalid-package-name', project.manifestPath, 'workspace package 必须声明 name')
  } else if (byName.has(project.manifest.name)) {
    report('duplicate-package-name', project.manifestPath, `重复 workspace package 名：${project.manifest.name}`)
  } else {
    byName.set(project.manifest.name, project)
  }
}

const rootReferences = new Set(
  ((await readJson(path.join(root, 'tsconfig.json'))).references ?? []).map((reference) =>
    path.resolve(root, reference.path).split(path.sep).join('/'),
  ),
)
for (const project of projects) {
  const directory = project.directory.split(path.sep).join('/')
  if (!rootReferences.has(directory)) {
    report('root-reference-mismatch', path.join(root, 'tsconfig.json'), `缺少 ${relative(project.directory)} reference`)
  }
}
for (const reference of rootReferences) {
  if (!byDirectory.has(reference)) {
    report('root-reference-mismatch', path.join(root, 'tsconfig.json'), `多余或未知 reference：${relative(reference)}`)
  }
}

const edges = new Map(projects.map((project) => [project.manifest.name, new Set()]))
for (const project of projects) {
  const productionDependencies = new Set(
    Object.keys({
      ...(project.manifest.dependencies ?? {}),
      ...(project.manifest.peerDependencies ?? {}),
      ...(project.manifest.optionalDependencies ?? {}),
    }).filter((name) => byName.has(name)),
  )
  const references = referencedProjectDirectories(project)
  const referencedNames = new Set(
    [...references].map((directory) => byDirectory.get(directory)?.manifest.name).filter(Boolean),
  )
  for (const dependency of productionDependencies) {
    edges.get(project.manifest.name)?.add(dependency)
    if (!referencedNames.has(dependency)) {
      report('manifest-reference-mismatch', project.tsconfigPath, `依赖 ${dependency} 缺少 tsconfig reference`)
    }
  }
  for (const referencedName of referencedNames) {
    if (!productionDependencies.has(referencedName)) {
      report('manifest-reference-mismatch', project.tsconfigPath, `reference ${referencedName} 不是生产 dependency`)
    }
  }

  for (const file of await sourceFiles(project.directory)) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const isProduction = relative(file).includes('/src/')
    for (const statement of source.statements) {
      let specifier
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        specifier =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined
      }
      if (!specifier?.startsWith('@nekro-nxt/')) continue
      const parts = specifier.split('/')
      const packageName = parts.slice(0, 2).join('/')
      const target = byName.get(packageName)
      if (!target) {
        report('unknown-workspace-import', file, `未知 workspace import：${specifier}`)
        continue
      }
      const allDependencies = {
        ...(project.manifest.dependencies ?? {}),
        ...(project.manifest.peerDependencies ?? {}),
        ...(project.manifest.optionalDependencies ?? {}),
        ...(isProduction ? {} : (project.manifest.devDependencies ?? {})),
      }
      if (!(packageName in allDependencies)) {
        report('undeclared-workspace-import', file, `${specifier} 未在 package.json 声明`)
      }
      if (project.group === 'packages' && target.group === 'apps') {
        report('cross-layer-import', file, `packages 不得反向导入 app：${specifier}`)
      }
      if (project.group === 'apps' && target.group === 'apps' && target !== project) {
        report('cross-layer-import', file, `app 之间不得直接导入：${specifier}`)
      }
      if (parts.length > 2) {
        const subpath = `./${parts.slice(2).join('/')}`
        if (!(subpath in (target.manifest.exports ?? {}))) {
          report('private-workspace-import', file, `${specifier} 未由目标 package exports 公开`)
        }
      }
    }
  }
}

const visiting = new Set()
const visited = new Set()
function visit(name, stack) {
  if (visiting.has(name)) {
    const start = stack.indexOf(name)
    const cycle = [...stack.slice(start), name]
    report('workspace-cycle', byName.get(name).manifestPath, `workspace 循环依赖：${cycle.join(' -> ')}`)
    return
  }
  if (visited.has(name)) return
  visiting.add(name)
  for (const dependency of edges.get(name) ?? []) visit(dependency, [...stack, name])
  visiting.delete(name)
  visited.add(name)
}
for (const name of edges.keys()) visit(name, [])

const baseline = await readBaseline(root, baselinePath).catch((error) => {
  if (process.argv.includes('--write-baseline') && error?.code === 'ENOENT') return { version: 1, counts: {} }
  throw error
})
const counts = countsFromFindings(findings)
if (process.argv.includes('--write-baseline')) {
  await writeBaseline(root, baselinePath, {
    version: 1,
    description: 'workspace manifest/reference 历史不一致；按规则和文件计数只能下降。',
    counts,
  })
  console.log(`Workspace boundary baseline updated (${findings.length} findings).`)
  process.exit(0)
}

const regressions = compareCounts(counts, baseline.counts ?? {})
if (regressions.length > 0) {
  for (const regression of regressions) {
    console.error(`${regression.file}: ${regression.rule} 当前 ${regression.count}，基线 ${regression.allowed}`)
    for (const finding of findings.filter((item) => item.rule === regression.rule && item.file === regression.file))
      console.error(`  ${finding.message}`)
  }
  process.exitCode = 1
} else {
  console.log(`Workspace boundary check passed (${findings.length} baseline findings, no increases).`)
}
