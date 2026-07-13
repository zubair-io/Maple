/**
 * Tests for GET /api/fs/thumb — RAW thumbnail extraction & cache.
 *
 * Behaviour exercised:
 *   - Unsupported extension          → 415
 *   - Path outside MAPLE_ROOTS jail  → 403
 *   - Cold render writes a thumbnail at the canonical .maple/ path
 *   - Warm read serves from cache (X-Thumb-Cache: hit) without rewriting
 *   - Touching the RAW invalidates the cache (cache-miss → regen)
 *
 * Mirrors the bare-Elysia-app-handle test pattern from
 * `tests/auth/enforcement.test.ts`. Each test mounts only the routes it
 * needs and skips the body of the FFI-heavy tests when (a) the native
 * library hasn't been built or (b) no small RAW fixture is available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

// JWT secret bootstrap (mirrors enforcement.test.ts) — even though the
// thumb route doesn't itself check auth, the shared `requireAuth`
// middleware reads MAPLE_JWT_SECRET at module load for sibling routes.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

// ---------------------------------------------------------------------------
// Locate a small RAW fixture and the native library; if either is absent,
// the FFI-dependent tests skip-pass.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const SMALL_FIXTURES = ['test_0006.DNG', 'test_0015.dng', 'test_0017.dng'];

function findFixture(): string | null {
  const dir = path.join(REPO_ROOT, 'test-fixtures', 'raws');
  for (const name of SMALL_FIXTURES) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const fixturePath = findFixture();
const nativeLib =
  process.platform === 'darwin'
    ? path.join(REPO_ROOT, 'src', 'api', 'native', 'libraw_ffi.dylib')
    : path.join(REPO_ROOT, 'src', 'api', 'native', 'libraw_ffi.so');
const ffiAvailable = existsSync(nativeLib);

const skipReason = !ffiAvailable
  ? 'skipping: FFI not built'
  : !fixturePath
    ? 'skipping: no fixtures'
    : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp() {
  const { fsThumbsRoutes } = await import('../../src/routes/fs-thumbs.ts');
  return new Elysia().use(fsThumbsRoutes);
}

async function copyFixtureTo(dst: string, src: string): Promise<void> {
  await fs.copyFile(src, dst);
}

// ---------------------------------------------------------------------------
// Tests that don't need the FFI/fixtures
// ---------------------------------------------------------------------------

describe('/api/fs/thumb — input validation (no FFI required)', () => {
  let tmp: string;

  beforeAll(async () => {
    const rawTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-thumb-test-'));
    tmp = await fs.realpath(rawTmp);
    process.env.MAPLE_ROOTS = tmp;
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.MAPLE_ROOTS;
  });

  it('rejects a non-RAW extension with 415', async () => {
    const app = await buildApp();
    const txtPath = path.join(tmp, 'not-a-raw.txt');
    await fs.writeFile(txtPath, 'hello');

    const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(txtPath)}&size=512`;
    const r = await app.handle(new Request(url));
    expect(r.status).toBe(415);
  });

  it('rejects a path outside MAPLE_ROOTS with 403', async () => {
    // Build a temp file outside `tmp` so realpath resolves but the jail rejects.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-outside-'));
    try {
      const fakeRaw = path.join(outside, 'test.dng');
      await fs.writeFile(fakeRaw, Buffer.from([0])); // not a real RAW, but ext check passes
      const app = await buildApp();
      const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(fakeRaw)}&size=512`;
      const r = await app.handle(new Request(url));
      expect(r.status).toBe(403);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a relative path with 400', async () => {
    const app = await buildApp();
    const r = await app.handle(
      new Request('http://localhost/api/fs/thumb?path=relative.dng&size=512'),
    );
    expect(r.status).toBe(400);
  });

  it('rejects an out-of-range size with 400', async () => {
    const app = await buildApp();
    const fakeRaw = path.join(tmp, 'ignored.dng');
    await fs.writeFile(fakeRaw, Buffer.from([0]));
    const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(fakeRaw)}&size=999999`;
    const r = await app.handle(new Request(url));
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// FFI + fixture tests (skip-pass without prerequisites)
// ---------------------------------------------------------------------------

describe('/api/fs/thumb — render & cache (FFI + fixture)', () => {
  let tmp: string;
  let stagedRaw: string;

  beforeAll(async () => {
    if (skipReason) {
      console.log(`[fs-thumbs.test] ${skipReason}`);
      return;
    }
    // Resolve symlinks in tmpdir so MAPLE_ROOTS matches realpath form on
    // macOS (where /var → /private/var). Mirrors the browseRoots() logic.
    const rawTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-thumb-test-'));
    tmp = await fs.realpath(rawTmp);
    process.env.MAPLE_ROOTS = tmp;
    stagedRaw = path.join(tmp, 'fixture.dng');
    await copyFixtureTo(stagedRaw, fixturePath!);
  });

  afterAll(async () => {
    if (skipReason) return;
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.MAPLE_ROOTS;
  });

  // Cold render: writes a thumb at the canonical path AND verifies the warm
  // cache-hit + stale-invalidation logic in the same `it()` block. We pack
  // every cache transition into a single test because Bun 1.3.12 has a
  // reproducible segfault on the SECOND FFI call after asynchronous I/O
  // through `app.handle` (Elysia + bun:ffi worker-thread interaction). The
  // workaround is to call the FFI exactly once in the FFI-dependent test
  // (cold-render below) and exercise the cache-hit/staleness logic via
  // hand-staged thumbs in separate tests that never touch the FFI.
  it('cold render writes a thumbnail at the canonical .maple/thumbs/ path', async () => {
    if (skipReason) {
      console.log(`[fs-thumbs.test] ${skipReason}`);
      return;
    }
    const app = await buildApp();
    const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(stagedRaw)}&size=256`;
    const { resolveThumbPath } = await import('../../src/fs/xmp.ts');
    const cachedPath = resolveThumbPath(stagedRaw);

    const r = await app.handle(new Request(url));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/avif');
    expect(r.headers.get('X-Thumb-Cache')).toBe('miss');

    const body = new Uint8Array(await r.arrayBuffer());
    // AVIF magic bytes: ISOBMFF box — 4-byte size, then "ftyp".
    expect(body[4]).toBe(0x66);
    expect(body[5]).toBe(0x74);
    expect(body[6]).toBe(0x79);
    expect(body[7]).toBe(0x70);
    expect(body.length).toBeGreaterThan(0);
    expect(existsSync(cachedPath)).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Cache-hit path — no FFI required. We hand-stage a thumb file at the
// canonical .maple/ path, then call the route and assert it's served from
// disk. This complements the FFI-dependent test above without triggering
// the Bun 1.3.12 multi-FFI-call crash.
// ---------------------------------------------------------------------------

describe('/api/fs/thumb — cache-hit (no FFI required)', () => {
  let tmp: string;
  let stagedRaw: string;
  let cachedPath: string;

  beforeAll(async () => {
    const rawTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-thumb-cache-'));
    tmp = await fs.realpath(rawTmp);
    process.env.MAPLE_ROOTS = tmp;
    stagedRaw = path.join(tmp, 'fixture.dng');
    // A near-empty file with .dng extension. The route only stat()s it and
    // checks the extension; only on a cache miss would it call the FFI.
    await fs.writeFile(stagedRaw, Buffer.from([0xff, 0xd8, 0xff]));

    const { resolveThumbPath } = await import('../../src/fs/xmp.ts');
    cachedPath = resolveThumbPath(stagedRaw);
    await fs.mkdir(path.dirname(cachedPath), { recursive: true });
    // Bytes that look like a real AVIF (ISOBMFF ftyp box). The route doesn't
    // validate AVIF content — it just streams the file bytes.
    await fs.writeFile(cachedPath, Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]));
    // Force the thumb's mtime to be AFTER the raw's mtime so the freshness
    // check returns "fresh".
    const rawStat = await fs.stat(stagedRaw);
    const future = rawStat.mtimeMs / 1000 + 60;
    await fs.utimes(cachedPath, future, future);
    // The freshness check also requires a .meta sidecar recording the
    // (mtimeMs, size) of the RAW that produced the cached thumb.
    // Without it, the route treats the thumb as stale and falls
    // through to the FFI regen path.
    await fs.writeFile(
      `${cachedPath}.meta`,
      JSON.stringify({ mtimeMs: rawStat.mtimeMs, size: rawStat.size }),
    );
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.MAPLE_ROOTS;
  });

  it('serves a fresh cached thumb without invoking FFI', async () => {
    const app = await buildApp();
    const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(stagedRaw)}&size=256`;
    const r = await app.handle(new Request(url));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/avif');
    expect(r.headers.get('X-Thumb-Cache')).toBe('hit');
    expect(r.headers.get('ETag')).toBeTruthy();
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body[4]).toBe(0x66);
    expect(body[5]).toBe(0x74);
    expect(body[6]).toBe(0x79);
    expect(body[7]).toBe(0x70);
  });

  it('regenerates when the raw is newer than the cached thumb', async () => {
    // Touch the raw to push its mtime past the thumb. The route must now
    // see fresh=false. We only assert the cache decision: if no FFI is
    // built we expect 503; if FFI is built we expect a successful regen.
    const thumbStat = await fs.stat(cachedPath);
    const future = thumbStat.mtimeMs / 1000 + 60;
    await fs.utimes(stagedRaw, future, future);

    const app = await buildApp();
    const url = `http://localhost/api/fs/thumb?path=${encodeURIComponent(stagedRaw)}&size=256`;
    const r = await app.handle(new Request(url));

    if (!ffiAvailable) {
      // Without the native lib, the route returns 503 on a cache miss.
      expect(r.status).toBe(503);
      return;
    }
    // FFI is built but the staged "raw" is fake bytes — the FFI will
    // either fail to decode (500) or produce an unrelated error. Either
    // way, the route did NOT serve from cache.
    expect(r.headers.get('X-Thumb-Cache')).not.toBe('hit');
  });
});
