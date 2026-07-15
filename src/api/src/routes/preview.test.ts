/**
 * Tests for PUT /api/preview?path=… — the path-keyed preview upload (#2017).
 *
 * The route path-authorizes against registered library roots (seeded via the
 * in-memory `setLibraryRootsForTests` seam, so no Mongo is needed), validates
 * the uploaded AVIF with a real decode, and atomically publishes it to
 * `<dir>/.maple/previews/<filename>.avif`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { previewPathRoutes } from './preview.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

/** A genuine, small, untagged-sRGB AVIF (≤ 1280 long edge) that passes the
 * #2014 `validateAvifOutput` gate — same encode shape as the render pipeline
 * (no ICC profile, no orientation tag, baked pixels). */
async function validAvif(): Promise<Buffer> {
  const width = 64;
  const height = 48;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .avif({ quality: 60, effort: 2 })
    .toBuffer();
}

describe('PUT /api/preview', () => {
  let tmp = '';

  const put = (path: string, body: BodyInit | undefined) =>
    new Elysia().use(previewPathRoutes).handle(
      new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body,
      }),
    );

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-put-preview-')));
    // Register `tmp` as a library root (in-memory, no Mongo) AND as an env
    // root so `resolveAndAuthorizePath` authorizes paths under it either way.
    setLibraryRootsForTests(new Map([[new ObjectId().toHexString(), tmp]]));
    process.env.MAPLE_ROOTS = tmp;
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = '';
    delete process.env.MAPLE_ROOTS;
    setLibraryRootsForTests(null);
    invalidateLibraryRoots();
  });

  it('publishes a valid AVIF to <dir>/.maple/previews/<filename>.avif and returns 204', async () => {
    const original = join(tmp, 'IMG_1234.CR2');
    const avif = await validAvif();

    const res = await put(original, avif);
    expect(res.status).toBe(204);

    // Written to the canonical cache path — filename incl. extension + `.avif`.
    const previewPath = join(tmp, '.maple', 'previews', 'IMG_1234.CR2.avif');
    const written = await readFile(previewPath);
    expect(Buffer.from(written)).toEqual(avif);
  });

  it('overwrites an existing preview in place (pure cache, no versioning)', async () => {
    const original = join(tmp, 'a.dng');
    const first = await validAvif();
    const second = await sharp({
      create: { width: 80, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .avif({ quality: 60, effort: 2 })
      .toBuffer();

    expect((await put(original, first)).status).toBe(204);
    expect((await put(original, second)).status).toBe(204);

    const previewPath = join(tmp, '.maple', 'previews', 'a.dng.avif');
    expect(Buffer.from(await readFile(previewPath))).toEqual(second);
  });

  it('rejects a non-AVIF body with 422 and writes nothing', async () => {
    const original = join(tmp, 'b.dng');
    const res = await put(original, Buffer.from('this is definitely not an AVIF file'));
    expect(res.status).toBe(422);

    const previewPath = join(tmp, '.maple', 'previews', 'b.dng.avif');
    await expect(stat(previewPath)).rejects.toThrow();
  });

  it('rejects a truncated AVIF body with 422', async () => {
    const original = join(tmp, 'c.dng');
    const avif = await validAvif();
    // Slice to a third of its length: the header may still parse, but the
    // pixel decode the validator forces will fail on the truncated payload.
    const truncated = avif.subarray(0, Math.max(1, Math.floor(avif.byteLength / 3)));

    const res = await put(original, truncated);
    expect(res.status).toBe(422);

    const previewPath = join(tmp, '.maple', 'previews', 'c.dng.avif');
    await expect(stat(previewPath)).rejects.toThrow();
  });

  it('rejects an empty body with 400', async () => {
    const original = join(tmp, 'd.dng');
    const res = await put(original, new Uint8Array(0));
    expect(res.status).toBe(400);
  });

  it('rejects a path outside every registered library root with 403', async () => {
    // A sibling temp path not under `tmp` (the only registered root).
    const outside = join(tmpdir(), `maple-outside-${process.pid}.dng`);
    const res = await put(outside, await validAvif());
    expect(res.status).toBe(403);
  });

  it('rejects an empty path value with 400', async () => {
    const res = await put('', await validAvif());
    expect(res.status).toBe(400);
  });
});
