import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { imageRoutes } from './image.ts';
import { clearMirrorRoots, setMirrorRoots } from '../../fs/mirror-registry.ts';
import { markMirrorUnhealthy, resetMirrorHealth, resetReadBalancer } from '../../fs/mirror-read.ts';
import { setLibraryBySlugForTests, invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { ObjectId } from '../../db/object-id.ts';
import { requestContext } from '../../middleware/request-context.ts';
import { securityHeaders } from '../../middleware/security-headers.ts';
import { resolveOriginalAddressRead } from '../../library/original-read.ts';

const BYTES = Buffer.from('immutable-original-0123456789');
let dir: string;
let primary: string;
let mirror: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'maple-image-replica-')));
  primary = path.join(dir, 'primary');
  mirror = path.join(dir, 'mirror');
  await fs.mkdir(primary);
  await fs.mkdir(mirror);
  await fs.writeFile(path.join(primary, 'photo.dng'), BYTES);
  await fs.copyFile(path.join(primary, 'photo.dng'), path.join(mirror, 'photo.dng'));
  const st = await fs.stat(path.join(primary, 'photo.dng'));
  await fs.utimes(path.join(mirror, 'photo.dng'), st.atime, st.mtime);
  setLibraryBySlugForTests('replicas', {
    libraryId: new ObjectId(),
    root: primary,
    label: 'Replicas',
  });
  setMirrorRoots({ [primary]: [mirror] });
  resetMirrorHealth();
  resetReadBalancer();
});

afterEach(async () => {
  clearMirrorRoots();
  resetMirrorHealth();
  invalidateLibraryRoots();
  await fs.rm(dir, { recursive: true, force: true });
});

function app() {
  return new Elysia({ prefix: '/api' }).use(requestContext).use(securityHeaders).use(imageRoutes);
}

function get(name = 'photo.dng', range?: string): Promise<Response> {
  return app().handle(
    new Request(`http://localhost/api/image/replicas/${name}`, {
      headers: range ? { Range: range } : {},
    }),
  );
}

describe('unified originals preserve replica and range contracts (#3999)', () => {
  test('serves a byte range through production middleware without expanding the slice', async () => {
    const response = await get('photo.dng', 'bytes=2-5');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes 2-5/${BYTES.length}`);
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Content-Type')).toBe('image/dng');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES.subarray(2, 6));
  });

  test('serves original bytes from the mirror when the primary volume disappears', async () => {
    await fs.rename(primary, path.join(dir, 'detached-primary'));
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(BYTES.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
  });

  test('serves suffix ranges from a surviving mirror', async () => {
    await fs.rename(primary, path.join(dir, 'detached-primary'));
    const response = await get('photo.dng', 'bytes=-4');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(
      `bytes ${BYTES.length - 4}-${BYTES.length - 1}/${BYTES.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES.subarray(-4));
  });

  for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-0']) {
    test(`returns 416 without original bytes for ${range}`, async () => {
      const response = await get('photo.dng', range);
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe(`bytes */${BYTES.length}`);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      const body = await response.json();
      expect(body.code).toBe('bad_request');
      expect(typeof body.requestId).toBe('string');
      expect(JSON.stringify(body)).not.toContain(BYTES.toString());
    });
  }

  test('real HTTP delivers exactly the requested bytes and authoritative length', async () => {
    const handler = app().compile();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler.fetch });
    try {
      const response = await fetch(new URL('/api/image/replicas/photo.dng', server.url), {
        headers: { Range: 'bytes=3-7' },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Length')).toBe('5');
      expect(response.headers.get('Content-Range')).toBe(`bytes 3-7/${BYTES.length}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES.subarray(3, 8));
    } finally {
      server.stop(true);
    }
  });

  test('healthy replicas balance reads while retaining identical authoritative response headers', async () => {
    const origins = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const resolved = await resolveOriginalAddressRead('replicas', 'photo.dng');
      expect(resolved.source).not.toBeNull();
      origins.add(resolved.source!.origin);
      expect(Buffer.from(await fs.readFile(resolved.source!.path))).toEqual(BYTES);
    }
    expect([...origins].sort()).toEqual(['mirror', 'primary']);
    const etags = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Length')).toBe(String(BYTES.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
      etags.add(response.headers.get('ETag')!);
    }
    expect(etags.size).toBe(1);
    const primaryStat = await fs.stat(path.join(primary, 'photo.dng'));
    expect([...etags][0]).toBe(`"${Math.floor(primaryStat.mtimeMs)}-${primaryStat.size}"`);
  });

  test('does not resurrect a file missing from a healthy primary', async () => {
    await fs.unlink(path.join(primary, 'photo.dng'));
    const response = await get();
    expect(response.status).toBe(404);
  });

  test('does not fail over to a benched mirror', async () => {
    markMirrorUnhealthy(mirror);
    await fs.rename(primary, path.join(dir, 'detached-primary'));
    expect((await get()).status).toBe(404);
  });

  test('returns 404 when neither original location exists', async () => {
    await fs.rename(primary, path.join(dir, 'detached-primary'));
    await fs.unlink(path.join(mirror, 'photo.dng'));
    expect((await get()).status).toBe(404);
  });

  test('ignores a mirror whose size or mtime differs from a healthy primary', async () => {
    await fs.writeFile(path.join(mirror, 'photo.dng'), 'stale');
    expect(Buffer.from(await (await get()).arrayBuffer())).toEqual(BYTES);
    await fs.writeFile(path.join(mirror, 'photo.dng'), Buffer.alloc(BYTES.length, 120));
    await fs.utimes(path.join(mirror, 'photo.dng'), new Date(0), new Date(0));
    resetReadBalancer();
    expect(Buffer.from(await (await get()).arrayBuffer())).toEqual(BYTES);
  });

  test.skipIf(process.platform === 'win32')(
    'rejects an outside symlink on the primary',
    async () => {
      const secret = path.join(dir, 'outside.dng');
      await fs.writeFile(secret, 'outside-secret');
      await fs.symlink(secret, path.join(primary, 'escape.dng'));
      const response = await get('escape.dng');
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('outside-secret');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'jails the selected mirror against an outside symlink',
    async () => {
      const secret = path.join(dir, 'outside.dng');
      await fs.writeFile(secret, BYTES);
      await fs.unlink(path.join(mirror, 'photo.dng'));
      await fs.symlink(secret, path.join(mirror, 'photo.dng'));
      await fs.rename(primary, path.join(dir, 'detached-primary'));
      const response = await get();
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(BYTES.toString());
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an escaping mirror cannot disrupt or replace a healthy primary read',
    async () => {
      const secret = path.join(dir, 'outside.dng');
      await fs.writeFile(secret, Buffer.alloc(BYTES.length, 120));
      const st = await fs.stat(path.join(primary, 'photo.dng'));
      await fs.utimes(secret, st.atime, st.mtime);
      await fs.unlink(path.join(mirror, 'photo.dng'));
      await fs.symlink(secret, path.join(mirror, 'photo.dng'));
      const response = await get();
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    },
  );

  test.skipIf(process.platform === 'win32')('serves an in-root primary symlink', async () => {
    await fs.symlink(path.join(primary, 'photo.dng'), path.join(primary, 'alias.dng'));
    const response = await get('alias.dng');
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
  });

  test.skipIf(process.platform === 'win32')(
    'serves an in-root mirror symlink during failover',
    async () => {
      await fs.symlink(path.join(mirror, 'photo.dng'), path.join(mirror, 'alias.dng'));
      await fs.rename(primary, path.join(dir, 'detached-primary'));
      const response = await get('alias.dng');
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an invalid first mirror falls through to a valid second mirror',
    async () => {
      const second = path.join(dir, 'second-mirror');
      await fs.mkdir(second);
      await fs.writeFile(path.join(second, 'photo.dng'), BYTES);
      const secret = path.join(dir, 'outside.dng');
      await fs.writeFile(secret, 'outside-secret');
      await fs.unlink(path.join(mirror, 'photo.dng'));
      await fs.symlink(secret, path.join(mirror, 'photo.dng'));
      setMirrorRoots({ [primary]: [mirror, second] });
      await fs.rename(primary, path.join(dir, 'detached-primary'));
      const response = await get();
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    },
  );

  test('rejects encoded traversal even when the primary is unavailable', async () => {
    await fs.rename(primary, path.join(dir, 'detached-primary'));
    const response = await get('..%2Foutside.dng');
    expect(response.status).toBe(400);
  });
});
