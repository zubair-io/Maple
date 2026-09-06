import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve(import.meta.dirname),
  server: { port: 4281, strictPort: true, fs: { allow: [resolve(import.meta.dirname, '../..')] } },
});
