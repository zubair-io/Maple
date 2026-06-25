/**
 * routes/static_ui.ts tests.
 *
 * Guards the production static-serving path, in particular the directory
 * containment check and the MAPLE_UI_DIST normalization that fronts it.
 *
 * UI_DIST is resolved once, at import time, from MAPLE_UI_DIST — so the env
 * is set (to a temp dir, with a deliberate trailing slash) before the dynamic
 * import below. The trailing slash is the regression guard: without
 * resolveUiDist() normalizing via path.resolve(), `UI_DIST + path.sep` would
 * be "<dist>//", which the normalized filePath never starts with, 403ing
 * every request.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Restore env after the suite so later test files in the same process aren't
// pinned to this temp dir / production mode.
const PRIOR_UI_DIST = process.env.MAPLE_UI_DIST;
const PRIOR_DEV = process.env.MAPLE_DEV;

// Build a throwaway dist tree before importing the module under test.
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-ui-dist-'));
const distDir = path.join(tmpRoot, 'browser');
await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>maple-ok</title>');
await fs.writeFile(path.join(distDir, 'assets', 'main.abcdef12.js'), 'console.log("hi");');

// Trailing slash on purpose — this is the regression the normalization fixes.
process.env.MAPLE_UI_DIST = distDir + path.sep;
delete process.env.MAPLE_DEV; // force the production serving path, not the proxy.

const { staticUiPlugin } = await import('./static_ui.ts');
const app = new Elysia().use(staticUiPlugin);

function get(p: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${p}`));
}

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  if (PRIOR_UI_DIST === undefined) delete process.env.MAPLE_UI_DIST;
  else process.env.MAPLE_UI_DIST = PRIOR_UI_DIST;
  if (PRIOR_DEV === undefined) delete process.env.MAPLE_DEV;
  else process.env.MAPLE_DEV = PRIOR_DEV;
});

describe('static_ui production serving', () => {
  it('serves index.html even when MAPLE_UI_DIST has a trailing slash', async () => {
    const res = await get('/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('maple-ok');
  });

  it('serves "/" as index.html', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('maple-ok');
  });

  it('serves a hashed asset with an immutable cache header', async () => {
    const res = await get('/assets/main.abcdef12.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });

  it('falls back to index.html (SPA) for unknown routes', async () => {
    const res = await get('/library/some/deep/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('maple-ok');
  });

  it('sets cross-origin isolation headers on file responses', async () => {
    const res = await get('/index.html');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
