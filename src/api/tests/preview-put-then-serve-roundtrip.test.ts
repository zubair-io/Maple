/**
 * Cross-platform round-trip validation (#1997, epic #1993 stage 5, item 2):
 * a client-shaped AVIF upload via `PUT /api/preview` — mimicking an
 * Apple-cloud or server-backed-web editor uploading a developed preview —
 * must be servable byte-identically through `GET /api/fs/preview?path=…`,
 * the path-addressed sibling read route that resolves the exact same
 * `<dir>/.maple/previews/<filename>.avif` cache file (no asset row needed).
 *
 * This is the server half of the "producer writes → contract holds for any
 * consumer" claim; `preview-path-contract.test.ts` covers the PATH agreement
 * across server/web/Apple, this file covers that the BYTES round-trip once
 * published.
 *
 * Deliberately does NOT also exercise `GET /api/preview/:slug/*` (the
 * indexed-asset route) here: that route resolves an asset via the
 * `libraries.cache.ts` in-memory slug map AND the app's `getDb()` singleton
 * (`db/client.ts`) — both process-wide, non-isolated caches shared by every
 * test file `bun test` runs concurrently in this process (default
 * `--max-concurrency=20`, ~300 files). A PUT-then-GET test does enough real
 * async work (AVIF encode, fs I/O, a Mongo round trip) between setup and
 * assertion that another concurrently-running file's own
 * `setLibraryRootsForTests` / `closeDb()` calls reliably land in the window
 * and resolve against a different file's registered library or database —
 * confirmed empirically while developing this test (consistent 202
 * "indexing" responses despite a correctly-inserted asset row, traced to
 * `getDb()`'s single memoized `_db` picking up whichever file's
 * `MAPLE_MONGO_DB` won the race to connect first). That's a pre-existing
 * trait of this suite's shared test seams, not a gap in the route itself;
 * fixing it needs per-file DB/process isolation (`bun test --parallel`) which
 * is out of scope here. `GET /api/preview/:slug/*`'s OWN dedicated test file
 * (`src/routes/library/preview.test.ts`) already covers it in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { previewPathRoutes } from '../src/routes/preview.ts';
import { fsPreviewsRoutes } from '../src/routes/fs-previews.ts';
import { cachePathFor } from '../src/fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../src/indexer/previewer.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

/** A genuine, decodable AVIF a real editor client would produce — passes the
 * #2014 `validateAvifOutput` gate (no ICC profile, no orientation tag). */
async function clientShapedAvif(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 90, b: 150 } },
  })
    .avif({ quality: 65, effort: 2 })
    .toBuffer();
}

const put = (path: string, body: BodyInit) =>
  new Elysia().use(previewPathRoutes).handle(
    new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/avif' },
      body,
    }),
  );

const getViaFs = (path: string) =>
  new Elysia()
    .use(fsPreviewsRoutes)
    .handle(new Request(`http://localhost/api/fs/preview?path=${encodeURIComponent(path)}`));

describe('PUT /api/preview → GET /api/fs/preview round-trips byte-identically (no DB needed)', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-roundtrip-')));
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

  it('a client-shaped PUT is served back byte-identical and decodable, with no on-demand regeneration clobbering it', async () => {
    const original = join(tmp, 'IMG_5150.dng');
    // The original must exist on disk (and be older than the PUT) for
    // GET /api/fs/preview's jail + freshness check — the uploaded preview is
    // NOT derived from this file's bytes (it's a client-supplied render), so
    // its content is irrelevant; only its existence + mtime ordering matter.
    await writeFile(original, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const uploaded = await clientShapedAvif();
    expect((await put(original, uploaded)).status).toBe(204);

    const res = await getViaFs(original);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/avif');
    expect(res.headers.get('etag')).toBeTruthy();

    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(uploaded)).toBe(true);

    // Decode-verify what was actually served (not just what was uploaded) —
    // proves the round-trip produced a genuine, complete AVIF end to end.
    const meta = await sharp(served).metadata();
    expect(meta.format).toBe('heif');
    expect(meta.compression).toBe('av1');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);

    // A second GET must 304 against the ETag from the first — confirms the
    // serving route treated the PUT'd file as fresh rather than
    // regenerating (which would also have produced a NEW ETag each time).
    const etag = res.headers.get('etag')!;
    const revalidated = await new Elysia().use(fsPreviewsRoutes).handle(
      new Request(`http://localhost/api/fs/preview?path=${encodeURIComponent(original)}`, {
        headers: { 'if-none-match': etag },
      }),
    );
    expect(revalidated.status).toBe(304);
  });

  it('PUT then GET agree on the exact same on-disk cache path (cachePathFor)', async () => {
    const original = join(tmp, 'a.nef');
    await writeFile(original, Buffer.from([0x00]));
    const uploaded = await clientShapedAvif();
    expect((await put(original, uploaded)).status).toBe(204);

    const expectedPath = cachePathFor(original, 'previews', PREVIEW_CACHE_SUFFIX);
    const res = await getViaFs(original);
    expect(res.status).toBe(200);
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(uploaded)).toBe(true);
    // Sanity: the legacy resolver both PUT and GET fall back to for an
    // un-indexed asset is the SAME function, applied to the SAME path.
    expect(expectedPath).toBe(join(tmp, '.maple', 'previews', 'a.nef.avif'));
  });
});
