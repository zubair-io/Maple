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
