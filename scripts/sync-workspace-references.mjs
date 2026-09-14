import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { format } from 'prettier'
import { workspaceProjects, workspaceRoot } from './lib/workspace-projects.mjs'

const projects = workspaceProjects()
const byName = new Map(projects.map((project) => [project.manifest.name, project]))
const targets = projects.map((project) => ({
  file: path.join(project.directory, 'tsconfig.json'),
  directory: project.directory,
  dependencies: Object.keys({
    ...project.manifest.dependencies,
    ...project.manifest.peerDependencies,
    ...project.manifest.optionalDependencies,
  }).flatMap((name) => {
    const target = byName.get(name)
    return target ? [target.directory] : []
  }),
}))
targets.push({
  file: path.join(workspaceRoot, 'tsconfig.json'),
  directory: workspaceRoot,
  dependencies: projects.map((project) => project.directory),
})
const drift = []
for (const { file, directory, dependencies } of targets) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const references = dependencies
    .map((target) => ({ path: path.relative(directory, target).split(path.sep).join('/') }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const actual = [...(config.references ?? [])].sort((a, b) => a.path.localeCompare(b.path))
  if (JSON.stringify(actual) === JSON.stringify(references)) continue
  if (process.argv.includes('--write'))
    writeFileSync(file, await format(JSON.stringify({ ...config, references }), { parser: 'json', printWidth: 120 }))
  else drift.push(path.relative(workspaceRoot, file))
}
if (drift.length) throw new Error(`TS references 与生产依赖不一致：${drift.join(', ')}；运行 pnpm sync:references。`)
console.log('Workspace references match production dependencies.')
