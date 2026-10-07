import { defineConfig } from 'tsdown'

const INTERNAL = /^@nekro-nxt\/(dsh-compat|adapter-sdk)(\/.*)?$/u

/**
 * npm 发布物：运行时内联 DSH 版本信息，类型内联 adapter-sdk 与 dsh-compat，
 * 只把已公开发布的 `@nekro-nxt/contracts` 留作依赖，扩展仓库安装后即可独立类型检查。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'publish/dist',
  clean: true,
  sourcemap: false,
  dts: true,
  deps: {
    alwaysBundle: [INTERNAL],
    neverBundle: ['@nekro-nxt/contracts', 'react', 'zod'],
    dts: { alwaysBundle: [INTERNAL], neverBundle: ['@nekro-nxt/contracts', 'react', 'zod'] },
  },
})
