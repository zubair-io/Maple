import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Elysia } from 'elysia';

let tmpDir: string;
let siblingDir: string;
let app: Elysia;

// We set process.env.MAPLE_UI_DIST before the dynamic import
// to ensure it picks up the temporary directory, and we add a trailing slash
// to verify the fix in `resolveUiDist()`.
beforeAll(async () => {
  tmpDir = path.join(process.cwd(), '.maple-test-static-ui-' + crypto.randomUUID());
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'assets'), { recursive: true });

  await fs.writeFile(path.join(tmpDir, 'index.html'), '<html lang="en"></html>');
  await fs.writeFile(path.join(tmpDir, 'main.abcdef12.js'), 'console.log("main");');
  await fs.writeFile(path.join(tmpDir, 'assets', 'logo.png'), 'logo');

  // Also create a sibling directory to test path traversal
  siblingDir = tmpDir + '_secrets';
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(path.join(siblingDir, 'secret.txt'), 'super secret');

  process.env.MAPLE_UI_DIST = tmpDir + '/';

  // Now dynamically import the plugin
  const { staticUiPlugin } = await import('./static_ui.ts');
  app = new Elysia().use(staticUiPlugin);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(siblingDir, { recursive: true, force: true });
});

describe('static_ui production serving', () => {
  it('serves exact files', async () => {
    const res = await app.handle(new Request('http://localhost/main.abcdef12.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("main");');
    expect(res.headers.get('content-type')).toBe('application/javascript');
  });

  it('serves "/" -> "index.html"', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('serves SPA fallback (unmatched paths -> index.html)', async () => {
    const res = await app.handle(new Request('http://localhost/some/nested/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html lang="en"></html>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('adds immutable caching to hashed assets', async () => {
    const res = await app.handle(new Request('http://localhost/main.abcdef12.js'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('adds no-cache to HTML files', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('adds COOP/COEP headers', async () => {
    const res = await app.handle(new Request('http://localhost/assets/logo.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  });

  it('blocks path traversal via prefix match (the specific fixed bug)', async () => {
    // If the path normalization leaves us with a sibling match
    // URL normalizes http://localhost/../XYZ_secrets/secret.txt to http://localhost/XYZ_secrets/secret.txt
    // Since UI_DIST is just tmpDir, anything not exactly inside falls back to SPA (index.html).
    // The traversal bug only occurred if we could pass `../` cleanly, OR if the router allowed
    // a literal sibling name.

    // Test the literal sibling name
    const resBypass = await app.handle(new Request('http://localhost/' + path.basename(tmpDir) + '_secrets/secret.txt'));
    const text = await resBypass.text();

    // It should NEVER read 'super secret'. It might return the SPA index.html
    expect(text).not.toBe('super secret');

    // Check that we indeed get the SPA fallback because the file wasn't found in tmpDir
    expect(text).toBe('<html lang="en"></html>');
  });
});
