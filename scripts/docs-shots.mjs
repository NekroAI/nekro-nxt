// The documentation screenshots (docs/site/BUNDLE.md).
//   pnpm docs:shots
// Clears .local/docs-shots, runs the flows, then renders the widgets even when a flow failed, since a widget can
// still show the shots that did land. Exits with the widgets' failure first, otherwise the flows'.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const run = (command) => spawnSync(command, { stdio: 'inherit', shell: true }).status ?? 1

rmSync('.local/docs-shots', { recursive: true, force: true })
const flows = run('playwright test -c playwright.docs.config.ts')
process.exit(run('node scripts/docs-widgets.mjs') || flows)
