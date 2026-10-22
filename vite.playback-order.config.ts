import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

/** Test-only harness. Never used by the production reader build. */
export default defineConfig({
  plugins: [react()],
  define: { __LATTE_DIAGNOSTICS__: JSON.stringify(false) },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    outDir: path.resolve(root, 'dist-playback-order'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(root, 'scripts/playback-order.html'),
    },
  },
  worker: { format: 'es' },
})
