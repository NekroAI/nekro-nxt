import path from 'node:path'
import { workspaceProjects, workspaceRoot } from './workspace-projects.mjs'

const projects = workspaceProjects()
const byName = new Map(projects.map((project) => [project.manifest.name, project]))

/** @type {import('eslint').Rule.RuleModule} */
export const workspaceBoundariesRule = {
  meta: { type: 'problem', schema: [], messages: { boundary: '{{message}}' } },
  create(context) {
    const file = path.relative(workspaceRoot, context.filename).split(path.sep).join('/')
    const main = file.startsWith('apps/server/src/') || file.startsWith('apps/web/src/')
    const check = (node) => {
      const specifier = node.source?.value
      if (typeof specifier !== 'string') return
      const report = (message) => context.report({ node: node.source, messageId: 'boundary', data: { message } })
      if (
        (specifier === 'better-sqlite3' || specifier === 'node:sqlite') &&
        file.includes('/src/') &&
        !file.startsWith('packages/storage-sqlite/src/')
      )
        report('原生数据库连接只能由 storage-sqlite 持有。')
      if (!specifier.startsWith('@nekro-nxt/')) return
      const segments = specifier.split('/')
      const name = segments.slice(0, 2).join('/')
      const project = byName.get(name)
      if (segments.length > 2 && project && !(`./${segments.slice(2).join('/')}` in (project.manifest.exports ?? {})))
        report(`${specifier} 未由目标包 exports 公开。`)
      if (
        main &&
        name.startsWith('@nekro-nxt/adapter-') &&
        name !== '@nekro-nxt/adapter-sdk' &&
        !(file.startsWith('apps/server/src/') && name === '@nekro-nxt/adapter-builtin-roster')
      )
        report('通用应用只能依赖 Adapter SDK；Server 额外允许内置 roster。')
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    }
  },
}
