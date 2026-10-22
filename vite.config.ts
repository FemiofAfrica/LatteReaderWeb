import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { privateDiagnosticsPlugin } from './scripts/privateDiagnosticsPlugin'

// Diagnostics (problem-report panel, event buffer, private ingestion) exist only
// in private tester builds (LATTE_PRIVATE_DIAGNOSTICS=1) and under the test
// runner. The public build compiles them out entirely.
const privateDiagnostics = process.env.LATTE_PRIVATE_DIAGNOSTICS === '1'
const diagnosticsCompiled = privateDiagnostics || Boolean(process.env.VITEST)

export default defineConfig({
  plugins: [react(), privateDiagnosticsPlugin(privateDiagnostics)],
  define: { __LATTE_DIAGNOSTICS__: JSON.stringify(diagnosticsCompiled) },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  // Isolated private verification must not overwrite a tester's active dist.
  build: { outDir: process.env.LATTE_BUILD_OUT || 'dist' },
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
