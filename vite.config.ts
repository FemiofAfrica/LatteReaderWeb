import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { privateDiagnosticsPlugin } from './scripts/privateDiagnosticsPlugin'

export default defineConfig({
  plugins: [react(), privateDiagnosticsPlugin(process.env.LATTE_PRIVATE_DIAGNOSTICS === '1')],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  // The narrator worker loads the pinned ONNX Runtime bundle from our own
  // origin with a dynamic import, so the worker itself has to be an ES module.
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: './src/test/setup.ts',
    coverage: { reporter: ['text', 'html'] },
  },
})
