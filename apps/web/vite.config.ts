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
  define: {
    __NEKRO_PRODUCT_VERSION__: JSON.stringify(productVersion),
    __NEKRO_PRODUCT_RELEASE_ID__: JSON.stringify(process.env['NEKRO_RELEASE_ID'] ?? ''),
  },
  resolve: {
    alias: workspaceSourceAliases,
    dedupe: ['react', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // 开发模式下把领域 API 转发到本机 NekroNxt Server（apps/server，默认 4960）。
      // 生产构建由 server 通过 dsh-host-frontend-static 同源托管，无需代理。
      '/health': { target: apiProxyTarget, changeOrigin: true },
      // 社区登录的回跳页由 Server 直接返回；不转发时会落到前端路由，登录永远完成不了。
      '/community/callback': { target: apiProxyTarget, changeOrigin: true },
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
