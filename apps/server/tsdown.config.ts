import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'

const productManifestSource = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
const productVersion = /^\s*"version"\s*:\s*"([^"]+)"/mu.exec(productManifestSource)?.[1]
if (productVersion === undefined || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(productVersion)) {
  throw new TypeError('根 package.json 缺少有效产品版本。')
}

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  clean: true,
  dts: false,
  sourcemap: true,
  define: { __NEKRO_PRODUCT_VERSION__: JSON.stringify(productVersion) },
})
