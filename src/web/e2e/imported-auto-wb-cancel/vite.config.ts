import { defineConfig } from 'vite';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { rawWasmAssetsPlugin } from '../vite-raw-wasm-assets';

const pkgDirectory = resolve(
  import.meta.dirname,
  '../../projects/maple-common/src/lib/raw-pipeline/pkg',
);
const raws = resolve(import.meta.dirname, '../../../../test-fixtures/raws');
const isolated = process.env['MAPLE_IMPORTED_WB_ISOLATED'] !== '0';

export default defineConfig({
  root: resolve(import.meta.dirname),
  optimizeDeps: { entries: ['main.ts'] },
  plugins: [rawWasmAssetsPlugin(pkgDirectory)],
  server: {
    port: isolated ? 4285 : 4286,
    strictPort: true,
    headers: isolated
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        }
      : {},
    // The RAWs are served from disk: a 100 MP file is too large for page.route.
    fs: {
      allow: [
        resolve(import.meta.dirname, '../..'),
        ...(existsSync(raws) ? [realpathSync(raws)] : []),
      ],
    },
  },
});
