/**
 * routes/static_ui.ts tests.
 *
 * Guards the production static-serving path: directory containment, the
 * MAPLE_UI_DIST normalization that fronts it, content types, and caching.
 *
 * UI_DIST is resolved once, at import time, from MAPLE_UI_DIST — so the env
 * is set (to a temp dir, with a deliberate trailing slash) before the dynamic
 * import below. The trailing slash is the regression guard: without
 * resolveUiDist() normalizing via path.resolve(), `UI_DIST + path.sep` would
 * be "<dist>//", which the normalized filePath never starts with, 403ing
 * every request.
 *
 * The dist fixture is written under os.tmpdir() with Bun.write (which creates
 * parent dirs) and torn down with Bun.spawnSync(rm) — never under cwd, and
 * without a node:fs import (src/api restricts raw fs outside the allowlist).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import os from 'node:os';
import path from 'node:path';

const PRIOR_UI_DIST = process.env.MAPLE_UI_DIST;
const PRIOR_DEV = process.env.MAPLE_DEV;

// One dir per process is unique enough — this file imports static_ui once.
const tmpRoot = path.join(os.tmpdir(), `maple-ui-dist-${process.pid}`);
const distDir = path.join(tmpRoot, 'browser');
// A sibling sharing the dist's path prefix — the exact shape the containment
// fix defends against (startsWith(UI_DIST) used to match "<dist>-anything").
const siblingDir = `${distDir}_secrets`;

await Bun.write(path.join(distDir, 'index.html'), '<html lang="en"></html>');
await Bun.write(path.join(distDir, 'main.abcdef12.js'), 'console.log("main");');
await Bun.write(path.join(distDir, 'assets', 'logo.png'), 'logo');
await Bun.write(path.join(siblingDir, 'secret.txt'), 'super secret');

// Trailing slash on purpose — this is the regression the normalization fixes.
process.env.MAPLE_UI_DIST = distDir + path.sep;
delete process.env.MAPLE_DEV; // force the production serving path, not the proxy.

const { staticUiPlugin } = await import('./static_ui.ts');
const app = new Elysia().use(staticUiPlugin);

function get(p: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${p}`));
}

afterAll(() => {
  Bun.spawnSync(['rm', '-rf', tmpRoot, siblingDir]);
  if (PRIOR_UI_DIST === undefined) delete process.env.MAPLE_UI_DIST;
  else process.env.MAPLE_UI_DIST = PRIOR_UI_DIST;
  if (PRIOR_DEV === undefined) delete process.env.MAPLE_DEV;
  else process.env.MAPLE_DEV = PRIOR_DEV;
});

describe('static_ui production serving', () => {
  it('serves an exact file even when MAPLE_UI_DIST has a trailing slash', async () => {
    const res = await get('/main.abcdef12.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("main");');
    expect(res.headers.get('content-type')).toBe('application/javascript');
  });

  it('serves "/" as index.html', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('falls back to index.html (SPA) for unmatched routes', async () => {
    const res = await get('/some/nested/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');
  });

  it('adds immutable caching to hashed assets, no-cache to HTML', async () => {
    const asset = await get('/main.abcdef12.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const html = await get('/');
    expect(html.headers.get('cache-control')).toBe('no-cache');
  });

  it('sets cross-origin isolation headers on file responses', async () => {
    const res = await get('/assets/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  });

  it('never serves a prefix-sibling secret via a traversal-shaped request', async () => {
    // new URL() normalizes the leading "../" out of the pathname, so the
    // request maps to "<UI_DIST>/<basename>_secrets/secret.txt" — inside
    // UI_DIST, where nothing exists — and falls back to index.html. The
    // containment check is the backstop if that normalization ever changes.
    const res = await get(`/../${path.basename(distDir)}_secrets/secret.txt`);
    const body = await res.text();
    expect(body).not.toBe('super secret');
    expect(body).toBe('<html lang="en"></html>');
  });
});

describe('static_ui /pkg asset-path 404 (#2408)', () => {
  it('404s a bare /pkg directory request instead of masking it as index.html', async () => {
    // Before the #2097/#2408 fix chain, a bare `/pkg` request (the shape a
    // bundler-oriented `import('../../..')` resolves to once bundled into a
    // worker chunk) silently 200'd as index.html — a browser `import()` of
    // that response fails opaquely instead of surfacing a clear 404, and
    // `initThreadPool` just hung until its 5s timeout.
    const res = await get('/pkg');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('html');
  });

  it('404s an unmatched (missing/typo\'d) path under /pkg/', async () => {
    const res = await get('/pkg/does-not-exist.js');
    expect(res.status).toBe(404);
  });

  it('serves the real file at /pkg/... when it exists on disk', async () => {
    await Bun.write(path.join(distDir, 'pkg', 'raw_wasm.js'), 'export default 1;');
    const res = await get('/pkg/raw_wasm.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('export default 1;');
  });

  it('still falls back to index.html for a real Angular route under /pkg-like prefixes', async () => {
    // Sanity: the guard is prefix-scoped to `/pkg`, not every path containing
    // the substring "pkg" — an app route like `/library/pkgconfig` is still
    // a normal SPA route.
    const res = await get('/library/pkgconfig');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');
  });

  it('does NOT 404 an /edit or /view deep link whose path segment is a real filename with an extension', async () => {
    // Regression guard: `/edit/:slug/**` and `/view/:slug/**` deep-link into
    // an image by embedding its real RAW filename (with extension) as a path
    // segment — e.g. a direct navigation/reload of
    // `/edit/mylib/raws/IMG_0001.CR2`. An earlier draft of the #2408 guard
    // 404'd any unmatched path whose last segment merely contained a dot,
    // which broke exactly this deep-link shape. The guard must stay scoped
    // to the `/pkg` prefix only.
    const res = await get('/edit/mylib/raws/IMG_0001.CR2');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');

    const viewRes = await get('/view/mylib/raws/IMG_0001.CR2');
    expect(viewRes.status).toBe(200);
    expect(await viewRes.text()).toBe('<html lang="en"></html>');
  });
});
