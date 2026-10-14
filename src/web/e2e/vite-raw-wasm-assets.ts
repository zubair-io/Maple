import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const PUBLIC_WASM_ASSETS = new Map([
  ['raw_wasm_bg.wasm', 'application/wasm'],
  ['raw_wasm.js', 'text/javascript'],
  ['workerHelpers.js', 'text/javascript'],
  ['workerHelpers.worker.js', 'text/javascript'],
]);

export function rawWasmAssetsPlugin(pkgDirectory: string): Plugin {
  return {
    name: 'raw-wasm-public-assets',
    configureServer(server) {
      server.middlewares.use('/pkg', (request, response, next) => {
        const asset = new URL(request.url ?? '/', 'http://vite.local').pathname.slice(1);
        const contentType = PUBLIC_WASM_ASSETS.get(asset);
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
  };
}
