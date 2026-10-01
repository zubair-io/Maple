import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve(import.meta.dirname),
  optimizeDeps: { entries: ['main.ts', 'hosted-raw-cache-test.ts'] },
  publicDir: resolve(import.meta.dirname, '../../../../resources'),
  server: {
    port: 4281,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
});
