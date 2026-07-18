/**
 * Tests for PUT /api/preview?path=… — the path-keyed preview upload (#2017).
 *
 * The route path-authorizes against registered library roots (seeded via the
 * in-memory `setLibraryRootsForTests` seam, so no Mongo is needed), validates
 * the uploaded AVIF with a real decode, and atomically publishes it to
 * `<dir>/.maple/previews/<filename>.avif`.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { previewPathRoutes } from './preview.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import * as imgdecodePoolModule from '../thumbs/imgdecode-pool.ts';

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

  // `Buffer` re-wrapped as `Uint8Array` — see the sibling `putBody` helper
  // below for why (Node's `Buffer` doesn't structurally satisfy `BodyInit`
  // under this tsconfig even though it is one at runtime).
  const put = (path: string, body: BodyInit | Buffer | undefined) =>
    new Elysia().use(previewPathRoutes).handle(
      new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
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

/**
 * JPEG-body coverage (#2018): browsers that can't canvas-encode AVIF post a
 * JPEG of the developed render instead; the server transcodes it to AVIF
 * before publishing.
 *
 * These stub ONLY the isolated-child subprocess boundary
 * (`renderImageThumbToFileViaPool`), transcoding in-process via sharp
 * instead — so a genuine AVIF still lands on disk and passes the real
 * `validateAvifOutput` gate (decode-verified, not asserted-by-mock), while
 * the route's own logic (format sniffing, the validation gate, atomic
 * publish, error mapping) is exercised end-to-end. Spawning the real child
 * here too added enough child-process churn to destabilise the shared pool
 * singleton under CI's constrained resources. The real isolated-child
 * transcode is covered by `imgdecode-pool.test.ts`'s own integration test.
 *
 * Stubbed via `spyOn` on the module namespace, NOT `mock.module` — #2032
 * proved a `mock.module` fake can leak past its restore on CI's (linux)
 * test-file collection order (that leak, in
 * `routes/library/preview-ondemand-limiter.test.ts`, was what deterministically
 * broke `workers/stages/preview.test.ts` on CI). `spyOn` patches the one
 * export in place and `mockRestore()` reverts it reliably for every importer.
 */
describe('PUT /api/preview — JPEG body (#2018 server-side transcode)', () => {
  let tmp = '';
  let renderStubSpy: { mockRestore(): void } | null = null;

  // `body` accepts a Buffer too (every caller below hands one in — sharp's
  // `.toBuffer()` and `Buffer.from()` both return `Buffer`) and re-wraps it as
  // a plain `Uint8Array`: Node's `Buffer` type doesn't structurally satisfy
  // DOM's `BodyInit` under this tsconfig even though it IS one at runtime
  // (Buffer extends Uint8Array) — same friction `Request`'s body option hits
  // elsewhere in this file; wrapping here keeps every call site below clean.
  const putBody = (path: string, body: BodyInit | Buffer, contentType = 'image/jpeg') =>
    new Elysia().use(previewPathRoutes).handle(
      new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
      }),
    );

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-put-preview-jpeg-')));
    setLibraryRootsForTests(new Map([[new ObjectId().toHexString(), tmp]]));
    process.env.MAPLE_ROOTS = tmp;
    // Transcode in-process via sharp (no child subprocess) — see the block
    // doc. Mirrors the pool's contract: writes a genuine AVIF to `outPath`
    // and returns `{ ok: false }` on an undecodable source (the route maps
    // that to 422).
    renderStubSpy = spyOn(imgdecodePoolModule, 'renderImageThumbToFileViaPool').mockImplementation(
      async (
        srcPath: string,
        outPath: string,
        maxPx: number,
        quality: number,
      ): Promise<{ ok: boolean; error?: string }> => {
        try {
          const out = await sharp(await readFile(srcPath))
            .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
            .avif({ quality })
            .toBuffer();
          await writeFile(outPath, out);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    );
  });

  afterEach(async () => {
    renderStubSpy?.mockRestore();
    renderStubSpy = null;
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = '';
    delete process.env.MAPLE_ROOTS;
    setLibraryRootsForTests(null);
    invalidateLibraryRoots();
  });

  it('transcodes a JPEG body to genuine AVIF on disk and returns 204', async () => {
    const original = join(tmp, 'IMG_5555.NEF');
    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 12, g: 200, b: 90 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const res = await putBody(original, jpeg);
    expect(res.status).toBe(204);

    const previewPath = join(tmp, '.maple', 'previews', 'IMG_5555.NEF.avif');
    const meta = await sharp(previewPath).metadata();
    // sharp reports AVIF as format "heif"/compression "av1" — see
    // `validate-avif.ts`'s module doc for why.
    expect(meta.format).toBe('heif');
    expect(meta.compression).toBe('av1');
    expect(meta.width).toBeLessThanOrEqual(200);
    expect(meta.height).toBeLessThanOrEqual(150);

    // No leftover JPEG-staging or AVIF-transcode temp files.
    const files = await readdir(join(tmp, '.maple', 'previews'));
    expect(files).toEqual(['IMG_5555.NEF.avif']);
  }, 15_000 /* generous timeout for the transcode + validation */);

  it('sniffs JPEG via magic bytes when Content-Type is generic/missing', async () => {
    const original = join(tmp, 'sniffed.dng');
    const jpeg = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    const res = await putBody(original, jpeg, 'application/octet-stream');
    expect(res.status).toBe(204);

    const previewPath = join(tmp, '.maple', 'previews', 'sniffed.dng.avif');
    const meta = await sharp(previewPath).metadata();
    expect(meta.format).toBe('heif');
  }, 15_000);

  it('rejects an undecodable JPEG body with 422 and writes nothing', async () => {
    const original = join(tmp, 'bad.dng');
    // Passes the magic-byte sniff (SOI marker) but has no actual image data
    // for sharp to decode — the transcode reports { ok: false }.
    const corrupt = new Uint8Array([0xff, 0xd8, 0xff]);

    const res = await putBody(original, corrupt);
    expect(res.status).toBe(422);

    const previewPath = join(tmp, '.maple', 'previews', 'bad.dng.avif');
    await expect(stat(previewPath)).rejects.toThrow();
  }, 15_000);

  it('rejects a body that is neither AVIF nor JPEG with 422 (no child spawned)', async () => {
    const original = join(tmp, 'neither.dng');
    const res = await putBody(
      original,
      Buffer.from('plain text, not an image'),
      'application/octet-stream',
    );
    expect(res.status).toBe(422);

    const previewPath = join(tmp, '.maple', 'previews', 'neither.dng.avif');
    await expect(stat(previewPath)).rejects.toThrow();
  });

  it('the existing AVIF-body path still works unchanged alongside the new JPEG path', async () => {
    const original = join(tmp, 'still-avif.dng');
    const raw = Buffer.alloc(32 * 24 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
    const avif = await sharp(raw, { raw: { width: 32, height: 24, channels: 3 } })
      .avif({ quality: 60, effort: 2 })
      .toBuffer();

    const res = await putBody(original, avif, 'image/avif');
    expect(res.status).toBe(204);

    const previewPath = join(tmp, '.maple', 'previews', 'still-avif.dng.avif');
    expect(Buffer.from(await readFile(previewPath))).toEqual(avif);
  });
});
