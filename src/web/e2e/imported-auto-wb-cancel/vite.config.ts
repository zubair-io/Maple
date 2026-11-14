import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { rawWasmAssetsPlugin } from '../vite-raw-wasm-assets';

const pkgDirectory = resolve(
  import.meta.dirname,
  '../../projects/maple-common/src/lib/raw-pipeline/pkg',
);

export default defineConfig({
  root: resolve(import.meta.dirname),
  optimizeDeps: { entries: ['main.ts'] },
  plugins: [rawWasmAssetsPlugin(pkgDirectory)],
  server: {
    port: 4285,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
});
