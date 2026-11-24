import { defineConfig } from 'vite'

const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

const RUNNER_PROXY = {
  target: process.env.RUNNER_ORIGIN || 'http://localhost:8787',
  changeOrigin: true,
}

export default defineConfig({
  server: {
    host: true,
    headers: CROSS_ORIGIN_ISOLATION,
    proxy: { '/run': RUNNER_PROXY, '/prepare': RUNNER_PROXY, '/clock': RUNNER_PROXY },
  },
})
