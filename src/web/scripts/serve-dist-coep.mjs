// Tiny static server for verifying the production Angular bundle with the
// cross-origin isolation headers the WASM rayon thread pool requires
// (COOP: same-origin + COEP: require-corp). Mirrors what src/api's
// static_ui.ts serves in production. Verification-only; not shipped.
//
// Usage: DIST=<abs path to dist/.../browser> PORT=4300 bun scripts/serve-dist-coep.mjs
import { file } from 'bun';
import { join, extname, normalize } from 'node:path';

const DIST = process.env.DIST;
const PORT = Number(process.env.PORT ?? 4300);
if (!DIST) {
  console.error('Set DIST to the browser dist dir');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.dng': 'image/x-adobe-dng',
};

function isolationHeaders(extra = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    ...extra,
  };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const abs = normalize(join(DIST, p));
    if (!abs.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const f = file(abs);
    if (await f.exists()) {
      const ct = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
      return new Response(f, { headers: isolationHeaders({ 'Content-Type': ct }) });
    }
    // SPA fallback
    const idx = file(join(DIST, 'index.html'));
    return new Response(idx, {
      headers: isolationHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
    });
  },
});
console.log(`serving ${DIST} on http://localhost:${PORT} with COOP/COEP`);
