import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { workspaceSourceAliases } from '../../scripts/workspace-source-aliases.mjs'

const apiProxyTarget = process.env['NEKRO_API_PROXY'] ?? 'http://127.0.0.1:4960'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: workspaceSourceAliases,
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 4961,
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
