/**
 * GET /api/fs/raw — mirror read replica behaviour at the route boundary (#926).
 *
 * The bytes on the wire are what matters here, plus the guarantee that a client
 * cannot tell which replica served: Content-Length and ETag must be identical
 * whichever copy the balancer picked. Also pins the two ways the route must NOT
 * reach for a mirror — a benched one, and a file simply missing from a healthy
 * primary.
 *
 * No Mongo: `/raw` only consults MAPLE_ROOTS.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import { markMirrorUnhealthy, resetMirrorHealth, resetReadBalancer } from '../fs/mirror-read.ts';
import { fsRoutes } from './fs.ts';

const RAW_BYTES = 'raw-bytes-for-the-decoder';

let dir: string;
let primary: string;
let mirror: string;
let priorRoots: string | undefined;

function get(path: string): Promise<Response> {
  return new Elysia()
    .use(fsRoutes)
    .handle(new Request(`http://localhost/api/fs/raw?path=${encodeURIComponent(path)}`));
}

beforeEach(async () => {
  dir = await realFs.realpath(await realFs.mkdtemp(join(tmpdir(), 'maple-raw-mirror-')));
  primary = join(dir, 'primary');
  mirror = join(dir, 'mirror');
  await realFs.mkdir(primary, { recursive: true });
  await realFs.mkdir(mirror, { recursive: true });
  await realFs.writeFile(join(primary, 'IMG.dng'), RAW_BYTES);
  await realFs.writeFile(join(mirror, 'IMG.dng'), RAW_BYTES);
  const st = await realFs.stat(join(primary, 'IMG.dng'));
  await realFs.utimes(join(mirror, 'IMG.dng'), st.atime, st.mtime);

  priorRoots = process.env.MAPLE_ROOTS;
  // `browseRoots()` memoises on the raw MAPLE_ROOTS value, so a fresh tmpdir
  // per test is enough to get a fresh resolve.
  process.env.MAPLE_ROOTS = dir;
  setMirrorRoots({ [primary]: [mirror] });
  resetMirrorHealth();
  resetReadBalancer();
});

afterEach(async () => {
  clearMirrorRoots();
  resetMirrorHealth();
  if (priorRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = priorRoots;
  await realFs.rm(dir, { recursive: true, force: true });
});

describe('GET /api/fs/raw with a mirror', () => {
  it('serves identical bytes and headers whichever replica the balancer picks', async () => {
    const seen = new Map<string, string>();
    for (let i = 0; i < 4; i++) {
      const res = await get(join(primary, 'IMG.dng'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(RAW_BYTES);
      seen.set(res.headers.get('ETag')!, res.headers.get('Content-Length')!);
    }
    // One ETag across all four responses ⇒ the client cannot observe which
    // replica served, so caches and conditional requests stay coherent.
    expect(seen.size).toBe(1);
    expect([...seen.values()][0]).toBe(String(RAW_BYTES.length));
  });

  it('serves from the mirror when the primary volume is unreachable', async () => {
    await realFs.rename(primary, join(dir, 'primary-detached'));
    const res = await get(join(primary, 'IMG.dng'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_BYTES);
  });

  it('404s rather than failing over when the primary is healthy but the file is gone', async () => {
    // The mirror still holds a copy whose unlink is queued — serving it would
    // resurrect a deleted photo.
    await realFs.unlink(join(primary, 'IMG.dng'));
    const res = await get(join(primary, 'IMG.dng'));
    expect(res.status).toBe(404);
  });

  it('does not fail over to a benched mirror', async () => {
    markMirrorUnhealthy(mirror);
    await realFs.rename(primary, join(dir, 'primary-detached'));
    const res = await get(join(primary, 'IMG.dng'));
    expect(res.status).toBe(404);
  });

  it('still 403s a path outside MAPLE_ROOTS when the primary is unreachable', async () => {
    await realFs.rename(primary, join(dir, 'primary-detached'));
    const res = await get('/definitely/not/in/roots/IMG.dng');
    expect(res.status).toBe(403);
  });
});
