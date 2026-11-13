import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { rawWasmAssetsPlugin } from '../vite-raw-wasm-assets';

const pkgDirectory = resolve(
  import.meta.dirname,
  '../../projects/maple-common/src/lib/raw-pipeline/pkg',
);

export default defineConfig({
  root: resolve(import.meta.dirname),
  // Serve only the WASM runtime assets under /pkg; do not expose the Rust
  // crate and generated TypeScript sources from the raw-pipeline directory.
  publicDir: false,
  plugins: [rawWasmAssetsPlugin(pkgDirectory)],
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
