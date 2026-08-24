import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

import { workspaceSourceAliases } from '../../scripts/workspace-source-aliases.mjs'

const apiProxyTarget = process.env['NEKRO_API_PROXY'] ?? 'http://127.0.0.1:4960'
const webPortInput = process.env['NEKRO_WEB_PORT']
const webPort = webPortInput === undefined || webPortInput.trim() === '' ? 4961 : Number(webPortInput)
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new TypeError(`NEKRO_WEB_PORT 无效：${webPortInput}`)
}
const productPackageSource = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
const productVersion = /^\s*"version"\s*:\s*"([^"]+)"/mu.exec(productPackageSource)?.[1]
if (!productVersion) throw new Error('根 package.json 缺少产品版本。')

export default defineConfig({
  plugins: [react()],
  define: { __NEKRO_PRODUCT_VERSION__: JSON.stringify(productVersion) },
  resolve: {
    alias: workspaceSourceAliases,
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // 开发模式下把领域 API 转发到本机 NekroNxt Server（apps/server，默认 4960）。
      // 生产构建由 server 通过 dsh-host-frontend-static 同源托管，无需代理。
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
