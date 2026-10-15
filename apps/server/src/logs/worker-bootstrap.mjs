// The source host uses tsx; production ships the compiled worker and never requires this dependency.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { workspaceSourceAliases } from '../../../../scripts/workspace-source-aliases.mjs'

// Workspace packages resolve to their TypeScript entries (as in the main thread under Vitest), so the worker needs
// no build output. The aliases are injected as data; the hook short-circuits only these exact specifiers.
const targets = Object.fromEntries(
  Object.entries(workspaceSourceAliases).map(([name, file]) => [name, pathToFileURL(file).href]),
)
register(
  `data:text/javascript,${encodeURIComponent(`
const targets = ${JSON.stringify(targets)}
export async function resolve(specifier, context, nextResolve) {
  const url = targets[specifier]
  return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
}
`)}`,
)
await tsImport(new URL('./storage-worker.ts', import.meta.url).href, import.meta.url)
