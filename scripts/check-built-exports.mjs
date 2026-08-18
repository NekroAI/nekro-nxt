import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const isNodeError = (error, code) => error instanceof Error && 'code' in error && error.code === code

async function workspaceManifests() {
  const manifests = []
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageRoot = path.join(root, group, entry.name)
      try {
        const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
        if (manifest.exports) manifests.push({ packageRoot, manifest })
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }
  return manifests
}

function exportTargets(entry) {
  if (typeof entry === 'string') return { importTarget: entry, typesTarget: undefined }
  if (!entry || typeof entry !== 'object') return { importTarget: undefined, typesTarget: undefined }
  return {
    importTarget: typeof entry.import === 'string' ? entry.import : undefined,
    typesTarget: typeof entry.types === 'string' ? entry.types : undefined,
  }
}

function declarationValueExports(file) {
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
      skipLibCheck: true,
      types: ['node'],
    },
  })
  const source = program.getSourceFile(file)
  if (!source) throw new Error(`Cannot load declaration entry ${path.relative(root, file)}`)
  const checker = program.getTypeChecker()
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) return []
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      return Boolean(target.flags & ts.SymbolFlags.Value)
    })
    .map((symbol) => symbol.name)
    .sort()
}

let checked = 0
for (const { packageRoot, manifest } of await workspaceManifests()) {
  const entries =
    typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
      ? Object.entries(manifest.exports)
      : [['.', manifest.exports]]
  for (const [subpath, entry] of entries) {
    if (!subpath.startsWith('.')) continue
    const { importTarget, typesTarget } = exportTargets(entry)
    if (!importTarget || !typesTarget) {
      throw new Error(`${manifest.name} ${subpath} 必须同时声明 import 与 types export。`)
    }
    const importFile = path.resolve(packageRoot, importTarget)
    const typesFile = path.resolve(packageRoot, typesTarget)
    const runtime = await import(pathToFileURL(importFile).href)
    const runtimeNames = Object.keys(runtime).sort()
    const typeValueNames = declarationValueExports(typesFile)
    if (JSON.stringify(runtimeNames) !== JSON.stringify(typeValueNames)) {
      const runtimeOnly = runtimeNames.filter((name) => !typeValueNames.includes(name))
      const declarationsOnly = typeValueNames.filter((name) => !runtimeNames.includes(name))
      throw new Error(
        `${manifest.name} ${subpath} JS/.d.ts 导出不一致` +
          `${runtimeOnly.length ? `；仅 JS：${runtimeOnly.join(', ')}` : ''}` +
          `${declarationsOnly.length ? `；仅 .d.ts：${declarationsOnly.join(', ')}` : ''}`,
      )
    }
    checked += 1
  }
}

console.log(`Built JS/.d.ts export check passed (${checked} export entries).`)
