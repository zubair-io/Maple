/**
 * Concurrent-writer / no-partial-AVIF test: `PUT /api/preview` racing the
 * `preview` worker stage's own writer (#1997, epic #1993 stage 5's
 * must-have — the "PUT racing the stage" variant of the concurrent-writer
 * gate; see `preview-concurrent-put-race.test.ts` for the N-parallel-PUTs
 * variant and shared reader-loop rationale).
 *
 * The stage handler (`workers/stages/preview.ts` → `generatePreview` in
 * `indexer/previewer.ts`) and the `PUT /api/preview` route
 * (`routes/preview.ts`) are two INDEPENDENT call sites that both publish to
 * the same `<dir>/.maple/previews/<filename>.avif` via write-to-private-
 * temp-then-rename — exactly the scenario a remote-editing client's `PUT`
 * landing while the background indexer's `preview` stage is re-rendering the
 * same (root-level, so both resolvers agree — see below) asset would hit in
 * production.
 *
 * `cachePathForAsset` (stage) and `cachePathFor` (PUT, via
 * `resolveAndAuthorizePath`) only resolve to the identical path for a
 * ROOT-LEVEL asset (`relDir === ''`); the fixture below uses one so the race
 * is genuine (both producers target the exact same file), matching
 * `tests/fixtures/preview-path-contract.json`'s `root_level` case.
 *
 * No Mongo needed — the stage handler resolves the library root via the
 * `setLibraryRootsForTests` in-memory seam (see `workers/stages/preview.test.ts`'s
 * "preview handler — bitmap path" block), same as the PUT route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import { previewPathRoutes } from '../src/routes/preview.ts';
import previewStage from '../src/workers/stages/preview.ts';
import { cachePathForAsset } from '../src/fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../src/indexer/previewer.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { distinctAvif, runReadersAgainst } from './helpers/preview-race.ts';

/** Minimal stage-handler doc, mirroring `workers/stages/preview.test.ts`'s
 * `makeDoc` — only the fields the handler and `cachePathForAsset` read. */
function makeDoc(filename: string, libraryId: ObjectId) {
  return {
    fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
    maple_id: 'a'.repeat(32),
  };
}

describe('PUT /api/preview racing the `preview` stage — no partial AVIF (#1997)', () => {
  let tmp = '';
  let scratchDir = '';
  let libraryId: ObjectId;

  const put = (path: string, body: BodyInit) =>
    new Elysia().use(previewPathRoutes).handle(
      new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body,
      }),
    );

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-stage-race-')));
    scratchDir = await mkdtemp(join(tmpdir(), 'maple-preview-stage-race-scratch-'));
    libraryId = new ObjectId();
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmp]]));
    process.env.MAPLE_ROOTS = tmp;
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    tmp = '';
    scratchDir = '';
    delete process.env.MAPLE_ROOTS;
    setLibraryRootsForTests(null);
    invalidateLibraryRoots();
  });

  it('a PUT racing several stage re-renders never lets a reader observe a torn/partial AVIF', async () => {
    // A real bitmap source the stage can actually decode+resize (mirrors
    // `workers/stages/preview.test.ts`'s bitmap-path fixture) — large enough
    // that its own decode+encode isn't instantaneous, and re-touched between
    // stage runs so `isPreviewCacheFresh`'s mtime check never short-circuits
    // a run into a no-op cache hit (which would collapse the race to a
    // single writer).
    const filename = 'wide.jpg';
    const sourcePath = join(tmp, filename);
    const doc = makeDoc(filename, libraryId);
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), tmp]]),
      'previews',
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();

    async function writeSourceJpeg(seed: number): Promise<void> {
      const buf = await sharp({
        create: {
          width: 1600,
          height: 1000,
          channels: 3,
          background: { r: seed % 255, g: 100, b: 150 },
        },
      })
        .jpeg()
        .toBuffer();
      await writeFile(sourcePath, buf);
    }

    const STAGE_RUN_COUNT = 5;
    const PUT_COUNT = 5;
    const READER_COUNT = 6;

    await writeSourceJpeg(0);

    const putCandidates: Buffer[] = await Promise.all(
      Array.from({ length: PUT_COUNT }, (_, i) => distinctAvif(i * 25, 60, 220 - i * 20)),
    );

    // Pre-seed via one real PUT so the race starts from an "old" state
    // already on disk.
    expect((await put(sourcePath, await distinctAvif(1, 2, 3))).status).toBe(204);

    const { observations, result } = await runReadersAgainst(
      previewPath as string,
      scratchDir,
      READER_COUNT,
      () =>
        Promise.all([
          ...Array.from({ length: STAGE_RUN_COUNT }, async (_, i) => {
            // Re-touch the source between stage runs so each invocation sees
            // a genuinely stale cache and actually re-renders (races the
            // publish step) instead of short-circuiting on the freshness
            // check.
            await writeSourceJpeg(i + 1);
            return previewStage.handler(doc as never, {} as never);
          }),
          ...putCandidates.map((body) => put(sourcePath, body)),
        ]),
    );

    const stageResults = result.slice(0, STAGE_RUN_COUNT) as Array<{ wrote?: boolean }>;
    const putResponses = result.slice(STAGE_RUN_COUNT) as Response[];

    for (const r of stageResults) {
      expect(r).toEqual({ wrote: true });
    }
    for (const res of putResponses) {
      expect(res.status).toBe(204);
    }

    // The must-have assertion: not ONE observation across the whole race was
    // a torn/partial/corrupt AVIF, regardless of which of the two producers
    // (stage or PUT) most recently published.
    expect(observations.length).toBeGreaterThan(0);
    const corrupt = observations.filter((o) => !o.ok);
    expect(corrupt).toEqual([]);

    // Final state is a genuinely valid, complete AVIF (published by whichever
    // producer's rename landed last) — not merely "some bytes exist".
    const finalBytes = await readFile(previewPath as string);
    expect(finalBytes.byteLength).toBeGreaterThan(0);
    const finalMeta = await sharp(previewPath as string).metadata();
    expect(finalMeta.format).toBe('heif'); // AVIF reports as heif+av1 — see validate-avif.ts
  });
});
