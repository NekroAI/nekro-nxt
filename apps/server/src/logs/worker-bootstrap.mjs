// The source host uses tsx; production ships the compiled worker and never requires this dependency.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tsImport } from 'tsx/esm/api'
import { workspaceSourceAliases } from '../../../../scripts/workspace-source-aliases.mjs'

// Workspace packages resolve to their TypeScript entries (as in the main thread under Vitest), so the worker needs
// no build output. tsx applies the tsconfig `paths` below to everything it loads.
const directory = mkdtempSync(path.join(tmpdir(), 'nxt-log-worker-'))
const tsconfig = path.join(directory, 'tsconfig.json')
writeFileSync(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: directory,
      paths: Object.fromEntries(Object.entries(workspaceSourceAliases).map(([name, file]) => [name, [file]])),
    },
  }),
)
await tsImport(new URL('./storage-worker.ts', import.meta.url).href, { parentURL: import.meta.url, tsconfig })
