// The source host uses tsx; production ships the compiled worker and never requires this dependency.
import { tsImport } from 'tsx/esm/api'
await tsImport(new URL('./storage-worker.ts', import.meta.url).href, import.meta.url)
