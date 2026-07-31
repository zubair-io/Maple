/**
 * Static UI serving for the Maple Self Hosted Angular bundle.
 *
 * In production: serves the compiled Angular app from the dist directory.
 *   - Static files from /api/* are handled by API routes first.
 *   - All other GET requests (Angular routes) fall through to index.html (SPA).
 *
 * In development (MAPLE_DEV=1): proxies to Angular dev server at
 *   MAPLE_DEV_ORIGIN (default: http://localhost:4201).
 *
 * The UI dist path is resolved relative to this server's root:
 *   <api>/../../web/dist/maple/browser/
 * Can be overridden via MAPLE_UI_DIST env var.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Elysia } from 'elysia';
import { child as childLogger } from '../log.ts';

const log = childLogger('static');

const IS_DEV = process.env.MAPLE_DEV === '1';
const DEV_ORIGIN = process.env.MAPLE_DEV_ORIGIN ?? 'http://localhost:4201';

/** Absolute path to the Angular production build. */
function resolveUiDist(): string {
  if (process.env.MAPLE_UI_DIST) {
    return path.resolve(process.env.MAPLE_UI_DIST);
  }
  // Relative to this file's location: src/routes/ → .. → src/ → .. → api/
  // Then up one more to the monorepo src/: ../web/dist/maple/browser/
  return path.resolve(
    import.meta.dir, // src/routes/
    '..', // src/
    '..', // api/
    '..', // src/      (monorepo src/)
    'web',
    'dist',
    'maple',
    'browser',
  );
}

let _uiDist: string | undefined;
/**
 * Memoised UI dist path. Resolved lazily so MAPLE_UI_DIST is read at first use
 * rather than at import — this keeps module load side-effect-free and lets
 * tests point it at a fixture dir before the first request.
 */
function uiDist(): string {
  return (_uiDist ??= resolveUiDist());
}

/** MIME type map for static serving. */
const MIME: Record<string, string> = {
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * Serve a static file from the UI dist directory.
 * Returns null if the file doesn't exist.
 */
async function serveStatic(uiRelPath: string): Promise<Response | null> {
  const root = uiDist();
  const filePath = path.join(root, uiRelPath);

  // Prevent directory traversal.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    const ct = mimeFor(filePath);
    const headers: Record<string, string> = { 'Content-Type': ct };

    // Long-lived cache for hashed assets; no-cache for HTML.
    if (ct.includes('html')) {
      headers['Cache-Control'] = 'no-cache';
    } else if (path.basename(filePath).match(/\.[a-f0-9]{8,}\.(js|css|wasm)$/)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }

    // T10: static UI responses must carry COOP/COEP so the page becomes
    // cross-origin-isolated and the WASM rayon thread pool can spin up.
    // Elysia's `onBeforeHandle` sets these on `set.headers` but when we
    // return a raw `Response` it doesn't always merge — set them directly
    // here so every file response has them.
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';

    return new Response(data, { status: 200, headers });
  } catch {
    return null;
  }
}

/**
 * Elysia plugin that mounts the static UI handler.
 *
 * This MUST be registered AFTER all /api/* routes so that API routes win.
 */
export const staticUiPlugin = new Elysia().get('/*', async ({ request, set }) => {
  const url = new URL(request.url);
  let uiPath = url.pathname;

  // In dev mode: proxy to Angular dev server.
  if (IS_DEV) {
    const target = DEV_ORIGIN + uiPath + (url.search ?? '');
    log.debug({ target }, 'DEV proxy');
    const proxyResp = await fetch(target, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
    }).catch((e) => {
      log.error({ err: e.message }, 'dev proxy error');
      return null;
    });
    if (!proxyResp) {
      set.status = 502;
      return {
        error: 'Angular dev server not reachable',
        tip: `Start it with: cd src/web && ng serve maple --port 4201`,
      };
    }
    // T10: proxied responses from `ng serve` don't carry COOP/COEP. Clone
    // with the isolation headers added so dev-mode threading works too.
    const proxyHeaders = new Headers(proxyResp.headers);
    proxyHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    proxyHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(proxyResp.body, {
      status: proxyResp.status,
      statusText: proxyResp.statusText,
      headers: proxyHeaders,
    });
  }

  // Production: serve from dist.
  // Strip leading slash.
  if (uiPath === '/' || uiPath === '') {
    uiPath = '/index.html';
  }

  // Check if dist exists; warn once if not.
  if (!_distExists && !(await checkDist())) {
    set.status = 503;
    return {
      error: 'UI bundle not built',
      tip: 'Run: cd src/web && ng build maple --configuration=production',
      dist_path: uiDist(),
    };
  }

  // Try to serve the exact path first.
  const exact = await serveStatic(uiPath);
  if (exact) return exact;

  // #2408: a request under the WASM bundle's `/pkg` prefix that missed above
  // (the bare directory `/pkg`, or a real filename that just doesn't exist,
  // e.g. a typo'd `/pkg/workerHelpers.worker.js`) is never an Angular route —
  // no app route lives under `/pkg` — so falling back to index.html for it
  // masks a missing/misnamed asset as a 200 `text/html` response. A browser
  // `import()` of that response then fails opaquely ("Unexpected token '<'")
  // instead of surfacing a clear 404, which is exactly how the WASM
  // thread-pool worker's self-spawn silently timed out instead of erroring
  // loudly before the underlying import was fixed to reference a real served
  // file. This check is deliberately scoped to `/pkg` rather than "any path
  // with a file extension" — Angular's own `/edit/:slug/**` and
  // `/view/:slug/**` deep-link routes embed a real RAW filename (with its
  // extension, e.g. `/edit/mylib/raws/IMG_0001.CR2`) as a path segment, so a
  // generic extension check would 404 a legitimate direct-navigation/reload
  // of the editor or preview route.
  if (isPkgAssetPath(uiPath)) {
    set.status = 404;
    return { error: 'Not found: ' + uiPath };
  }

  // SPA fallback: serve index.html for any unmatched app route.
  const indexHtml = await serveStatic('/index.html');
  if (indexHtml) return indexHtml;

  set.status = 404;
  return { error: 'UI index.html not found in ' + uiDist() };
});

/**
 * True for paths that reference the WASM `/pkg` bundle rather than an
 * Angular route (including the bare `/pkg` directory itself — no app route
 * lives under that prefix). The SPA fallback must never answer these with
 * index.html — see the #2408 comment above.
 */
function isPkgAssetPath(uiPath: string): boolean {
  return uiPath === '/pkg' || uiPath.startsWith('/pkg/');
}

// One-time dist availability check.
let _distExists: boolean | null = null;

async function checkDist(): Promise<boolean> {
  if (_distExists !== null) return _distExists;
  try {
    await fs.access(path.join(uiDist(), 'index.html'));
    _distExists = true;
    log.info({ uiDist: uiDist() }, 'UI dist found');
  } catch {
    _distExists = false;
    log.warn({ uiDist: uiDist() }, 'UI dist NOT found');
  }
  return _distExists;
}
