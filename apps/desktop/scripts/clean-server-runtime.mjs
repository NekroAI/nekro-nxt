import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const runtimeRoot = fileURLToPath(new URL('../dist/runtime', import.meta.url))

// pnpm deploy may place workspace links under this directory. Remove the
// directory before tsdown clean can traverse any stale link from a prior dist.
await rm(runtimeRoot, { recursive: true, force: true })
