import { PIPELINE_OUTPUT_VERSION } from '../src/generated/adjustment-fields.generated.ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maple } from 'maple';
import { solidAvif } from '../src/test-support/synth-image.ts';

import { previewPathRoutes } from '../src/routes/preview.ts';
import { previewRoutes } from '../src/routes/library/preview.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { registerLibrary, seedRouteAsset } from './helpers/assets-route-fixtures.ts';
import { cachePathFor } from '../src/fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../src/indexer/previewer.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

/** A genuine, decodable AVIF a real editor client would produce — passes the
 * #2014 `validateAvifOutput` gate (no ICC profile, no orientation tag). */
async function clientShapedAvif(): Promise<Buffer> {
  return solidAvif(640, 480, [30, 90, 150], 65, 2);
}

const put = (path: string, body: BodyInit | Buffer) =>
  new Elysia().use(previewPathRoutes).handle(
    new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: {
        'x-maple-pipeline-version': String(PIPELINE_OUTPUT_VERSION),
        'content-type': 'image/avif',
      },
      body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
    }),
  );

const getPreview = (file: string, etag?: string) =>
  new Elysia().use(previewRoutes).handle(
    new Request(`http://localhost/preview/photos/${encodeURIComponent(file.split('/').at(-1)!)}`, {
      headers: etag ? { 'If-None-Match': etag } : undefined,
    }),
  );

describe('Client preview PUT → unified preview GET with real SQLite addressing', () => {
  let tmp = '';
  let live: LiveTestDatabase;
  let libraryId: string;
  let previousRoots: string | undefined;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-roundtrip-')));
    live = await createLiveTestDatabase();
    libraryId = registerLibrary(live.db, tmp, 'photos');
    previousRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = tmp;
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = '';
    if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousRoots;
    live.close();
    invalidateLibraryRoots();
  });

  it('a client-shaped PUT is served back byte-identical and decodable, with no on-demand regeneration clobbering it', async () => {
    const original = join(tmp, 'IMG_5150.dng');
    // The original must exist on disk (and be older than the PUT) for
    // the unified preview jail + freshness check — the uploaded preview is
    // NOT derived from this file's bytes (it's a client-supplied render), so
    // its content is irrelevant; only its existence + mtime ordering matter.
    await writeFile(original, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: original.split('/').at(-1)!,
    });
    const uploaded = await clientShapedAvif();
    expect((await put(original, uploaded)).status).toBe(204);

    const res = await getPreview(original);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/avif');
    expect(res.headers.get('etag')).toBeTruthy();

    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(uploaded)).toBe(true);

    // Decode-verify what was actually served (not just what was uploaded) —
    // proves the round-trip produced a genuine, complete AVIF end to end.
    const meta = await maple(served).metadata();
    expect(meta.format).toBe('heif');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);

    // A second GET must 304 against the ETag from the first — confirms the
    // serving route treated the PUT'd file as fresh rather than
    // regenerating (which would also have produced a NEW ETag each time).
    const etag = res.headers.get('etag')!;
    const revalidated = await getPreview(original, etag);
    expect(revalidated.status).toBe(304);
  });

  it('PUT then GET agree on the exact same on-disk cache path (cachePathFor)', async () => {
    const original = join(tmp, 'a.nef');
    await writeFile(original, Buffer.from([0x00]));
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: original.split('/').at(-1)!,
    });
    const uploaded = await clientShapedAvif();
    expect((await put(original, uploaded)).status).toBe(204);

    const expectedPath = cachePathFor(original, 'previews', PREVIEW_CACHE_SUFFIX);
    const res = await getPreview(original);
    expect(res.status).toBe(200);
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(uploaded)).toBe(true);
    expect(expectedPath).toBe(
      join(tmp, '.maple', 'previews', `a.nef.v${PIPELINE_OUTPUT_VERSION}.avif`),
    );
  });
});
