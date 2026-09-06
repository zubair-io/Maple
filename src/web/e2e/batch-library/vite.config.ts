import { defineConfig } from 'vite';
import { createReadStream, promises as fs } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const corpus = process.env['MAPLE_BATCH_CORPUS'];
export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: resolve(import.meta.dirname, '../../projects/maple-common/src/lib/raw-pipeline'),
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 4283,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
  plugins: [
    {
      name: 'owned-photo-corpus',
      async configureServer(server) {
        if (!corpus) throw new Error('Set MAPLE_BATCH_CORPUS to disposable photo copies.');
        const directory = await fs.realpath(corpus);
        const temporary = await fs.realpath(tmpdir());
        if (!directory.startsWith(temporary + '/') && !directory.startsWith('/private/tmp/'))
          throw new Error('Only an owned temporary corpus is accepted.');
        const names = (await fs.readdir(directory))
          .filter((name) => /^asset-\d{4}\.[a-z0-9]+$/i.test(name) && extname(name) !== '.xmp')
          .sort();
        if (names.length !== 2000)
          throw new Error('The corpus must contain 2,000 staged photographs.');
        const manifest = await Promise.all(
          names.map(async (name) => {
            const path = join(directory, name);
            if ((await fs.realpath(path)) !== path)
              throw new Error('Corpus files must not be symlinks.');
            const stat = await fs.stat(path);
            return { name, size: stat.size, lastModified: stat.mtimeMs };
          }),
        );
        server.middlewares.use((request, response, next) => {
          if (request.url === '/corpus-manifest') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(manifest));
            return;
          }
          const name = request.url?.startsWith('/corpus/') ? request.url.slice(8) : undefined;
          if (!name || !names.includes(name)) {
            next();
            return;
          }
          response.setHeader('Content-Type', 'application/octet-stream');
          createReadStream(join(directory, name)).pipe(response);
        });
      },
    },
  ],
});
