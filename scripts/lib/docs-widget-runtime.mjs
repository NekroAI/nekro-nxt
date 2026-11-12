// The documentation widgets' runtime as one ES module (docs/site/widgets/runtime); the site imports it and mounts each
// widget. scripts/docs-widgets.mjs renders the widgets' images with it and scripts/docs-bundle.mjs publishes it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../docs/site/widgets/runtime/index.tsx',
)
/** Where `pnpm docs:shots` puts the widgets' images, inside the shots directory. */
export const WIDGETS_DIR = 'widgets'

export async function buildWidgetRuntime() {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [RUNTIME_ENTRY],
    bundle: true,
    format: 'esm',
    minify: true,
    write: false,
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    legalComments: 'none',
    charset: 'utf8',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error('组件运行时没有生成')
  return output.text
}
