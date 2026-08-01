// Tiny static server for verifying the production Angular bundle with the
// cross-origin isolation headers the WASM rayon thread pool requires
// (COOP: same-origin + COEP: require-corp). Mirrors what src/api's
// static_ui.ts serves in production. Verification-only; not shipped.
//
// Usage: DIST=<abs path to dist/.../browser> PORT=4300 bun scripts/serve-dist-coep.mjs
import { file } from 'bun';
import { join, extname, normalize, resolve, sep } from 'node:path';

if (!process.env.DIST) {
  console.error('Set DIST to the browser dist dir');
  process.exit(1);
}
// Resolve to an absolute, separator-normalized root so the traversal guard's
// `DIST + sep` boundary check is exact (no trailing-slash surprises).
const DIST = resolve(process.env.DIST);
const PORT = Number(process.env.PORT ?? 4300);
const API_UNAVAILABLE_STATUS = Number(process.env.API_UNAVAILABLE_STATUS ?? 0);

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

/** Default `/` (and empty) to index.html; leave everything else untouched. */
function resolvePathname(rawPathname) {
  const p = decodeURIComponent(rawPathname);
  return p === '/' || p === '' ? '/index.html' : p;
}

/**
 * Directory-traversal guard: an exact match or a real separator boundary, so a
 * sibling like `${DIST}_secrets/…` can't pass a bare prefix check. Mirrors
 * src/api's static_ui.ts.
 */
function isWithinRoot(abs) {
  return abs === DIST || abs.startsWith(DIST + sep);
}

function contentTypeFor(abs) {
  return MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
}

function isolatedResponse(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  });
}

function unavailableApiResponse(pathname) {
  if (!API_UNAVAILABLE_STATUS) return null;
  if (pathname === '/api/auth/bootstrap') {
    return isolatedResponse(
      JSON.stringify({ claimed: true, dev_login_enabled: false }),
      'application/json',
    );
  }
  if (pathname.startsWith('/api/')) {
    return isolatedResponse('Unauthorized', 'text/plain; charset=utf-8', API_UNAVAILABLE_STATUS);
  }
  return null;
}

async function handle(req) {
  const pathname = new URL(req.url).pathname;
  const apiResponse = unavailableApiResponse(pathname);
  if (apiResponse) return apiResponse;
  const abs = normalize(join(DIST, resolvePathname(pathname)));
  if (!isWithinRoot(abs)) return new Response('Forbidden', { status: 403 });
  const f = file(abs);
  if (await f.exists()) return isolatedResponse(f, contentTypeFor(abs));
  // SPA fallback.
  return isolatedResponse(file(join(DIST, 'index.html')), 'text/html; charset=utf-8');
}

Bun.serve({ port: PORT, fetch: handle });
console.log(`serving ${DIST} on http://localhost:${PORT} with COOP/COEP`);
