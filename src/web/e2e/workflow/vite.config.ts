import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: resolve(import.meta.dirname, '../../projects/maple-common/src/lib/raw-pipeline/pkg'),
  server: {
    port: 4518,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4519',
      '/workflow-fixture': 'http://127.0.0.1:4519',
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
});
