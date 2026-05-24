/**
 * `/api/fs/dir-fast` is the pure-filesystem variant of `/api/fs/dir` used
 * by the Angular Browse grid. It must:
 *   - return the same path/parent/dirs/images shape as /dir, minus EXIF
 *     and asset_id and sidecars,
 *   - NOT touch Mongo (no DB connection attempted; safe to run with
 *     MAPLE_MONGO_URI unset),
 *   - drop `.xmp` filenames silently (they aren't surfaced),
 *   - respect the same paging cursor contract as /dir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

describe('GET /api/fs/dir-fast', () => {
  let tmpRoot: string;
  let realTmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-fsdirfast-'));
    realTmpRoot = await fs.realpath(tmpRoot);

    await fs.mkdir(path.join(tmpRoot, 'Trip1'));
    await fs.mkdir(path.join(tmpRoot, '.hidden'));

    await fs.writeFile(path.join(tmpRoot, 'IMG_001.CR3'), 'raw');
    await fs.writeFile(path.join(tmpRoot, 'IMG_002.dng'), 'raw');
    await fs.writeFile(path.join(tmpRoot, 'preview.jpg'), 'x');
    // sidecar — must be silently dropped
    await fs.writeFile(path.join(tmpRoot, 'IMG_001.xmp'), '<xmp/>');
    // non-image — filtered by extension
    await fs.writeFile(path.join(tmpRoot, 'notes.txt'), 'x');
    await fs.writeFile(path.join(tmpRoot, '.env'), 'x');

    process.env.MAPLE_ROOTS = realTmpRoot;
    // Deliberately do NOT set MAPLE_MONGO_URI — this endpoint must work
    // without Mongo reachable.
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns subdirs and image files at the level, no sidecars/exif/id', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir-fast?path=${encodeURIComponent(tmpRoot)}`),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      path: string;
      parent: string | null;
      dirs: Array<{ name: string }>;
      images: Array<{ name: string; size: number; ext: string; id?: string; exif?: unknown }>;
      sidecars?: unknown;
    };

    expect(json.path).toBe(realTmpRoot);
    expect(json.parent).toBe(path.dirname(realTmpRoot));
    expect(json.dirs.map((d) => d.name)).toEqual(['Trip1']);

    const imgNames = json.images.map((i) => i.name).sort();
    expect(imgNames).toEqual(['IMG_001.CR3', 'IMG_002.dng', 'preview.jpg']);

    // No DB enrichment surfaces here.
    for (const img of json.images) {
      expect(img.id).toBeUndefined();
      expect(img.exif).toBeUndefined();
    }
    // No `sidecars` key in the shape at all.
    expect('sidecars' in json).toBe(false);
  });

  it('drops .xmp filenames from the listing', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir-fast?path=${encodeURIComponent(tmpRoot)}`),
    );
    const json = (await res.json()) as { images: Array<{ name: string }> };
    const names = json.images.map((i) => i.name);
    expect(names).not.toContain('IMG_001.xmp');
  });

  it('returns 400 for path outside MAPLE_ROOTS', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir-fast?path=${encodeURIComponent('/tmp')}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-absolute path', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir-fast?path=${encodeURIComponent('relative/path')}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-integer limit', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir-fast?path=${encodeURIComponent(tmpRoot)}&limit=abc`),
    );
    expect(res.status).toBe(400);
  });
});
