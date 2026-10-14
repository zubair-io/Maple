import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

const pkgDirectory = resolve(
  import.meta.dirname,
  '../../projects/maple-common/src/lib/raw-pipeline/pkg',
);
const publicWasmAssets = new Map([
  ['raw_wasm_bg.wasm', 'application/wasm'],
  ['raw_wasm.js', 'text/javascript'],
  ['workerHelpers.js', 'text/javascript'],
  ['workerHelpers.worker.js', 'text/javascript'],
]);

export default defineConfig({
  root: resolve(import.meta.dirname),
  // Serve only the WASM runtime assets under /pkg; do not expose the Rust
  // crate and generated TypeScript sources from the raw-pipeline directory.
  publicDir: false,
  plugins: [
    {
      name: 'workflow-wasm-assets',
      configureServer(server) {
        server.middlewares.use('/pkg', (request, response, next) => {
          const asset = new URL(request.url ?? '/', 'http://vite.local').pathname.slice(1);
          const contentType = publicWasmAssets.get(asset);
          if (!contentType || (request.method !== 'GET' && request.method !== 'HEAD')) {
            next();
            return;
          }

          response.setHeader('Content-Type', contentType);
          if (request.method === 'HEAD') {
            response.end();
            return;
          }

          const stream = createReadStream(resolve(pkgDirectory, asset));
          stream.on('error', () => {
            if (response.headersSent) response.destroy();
            else {
              response.statusCode = 404;
              response.end();
            }
          });
          stream.pipe(response);
        });
      },
    },
  ],
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
