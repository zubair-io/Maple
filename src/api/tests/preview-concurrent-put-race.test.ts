/**
 * Concurrent-writer / no-partial-AVIF test for `PUT /api/preview` (#1997,
 * epic #1993 stage 5's must-have server-side gate).
 *
 * `PUT /api/preview` publishes via write-to-private-temp-then-rename
 * (`routes/preview.ts`: stage tmp → `validateAvifOutput` decode → `fs.rename`
 * into `<dir>/.maple/previews/<filename>.avif`). POSIX `rename(2)` onto an
 * existing path is atomic: any reader opening that path sees EITHER the
 * pre-rename inode's full content or the post-rename inode's full content —
 * never a mix, and never a truncated write, because a reader's `open()` never
 * targets the writer's private temp file.
 *
 * This test races many concurrent PUTs against the SAME asset path while
 * concurrent readers hammer the shared preview file (`runReadersAgainst` /
 * `raceReaderLoop`, `tests/helpers/preview-race.ts`), and asserts every single
 * read the racing readers observe decodes as a genuine, complete AVIF via the
 * real #2014 `validateAvifOutput` path — never a partial/corrupt read. It also
 * confirms the file left behind after the race is one of the byte-exact
 * candidates (the pre-seeded "old" version or one of the racing "new"
 * uploads), not some fifth thing a torn write could produce.
 *
 * The reader-loop strategy this relies on was sanity-checked against a
 * deliberately non-atomic (truncate-then-write-in-two-chunks) writer during
 * development, confirming it reliably produces `ok:false` observations for a
 * genuinely torn write — see the PR description for the throwaway repro.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';

import { previewPathRoutes } from '../src/routes/preview.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { distinctAvif, runReadersAgainst } from './helpers/preview-race.ts';

describe('PUT /api/preview — concurrent writers never expose a partial AVIF (#1997)', () => {
  let tmp = '';
  let scratchDir = '';

  const put = (path: string, body: BodyInit) =>
    new Elysia().use(previewPathRoutes).handle(
      new Request(`http://localhost/api/preview?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body,
      }),
    );

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-race-')));
    scratchDir = await mkdtemp(join(tmpdir(), 'maple-preview-race-scratch-'));
    setLibraryRootsForTests(new Map([[new ObjectId().toHexString(), tmp]]));
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

  it('N parallel PUTs to the same path never let a concurrent reader observe a torn/partial AVIF', async () => {
    const original = join(tmp, 'IMG_9001.CR2');
    const previewPath = join(tmp, '.maple', 'previews', 'IMG_9001.CR2.avif');

    const WRITER_COUNT = 10;
    const READER_COUNT = 6;
    const candidates: Buffer[] = await Promise.all(
      Array.from({ length: WRITER_COUNT }, (_, i) => distinctAvif(i * 20, 40, 200 - i * 15)),
    );
    const seed = await distinctAvif(1, 2, 3);

    // Pre-seed so the race starts from an "old" state that already exists on
    // disk — this is what proves a reader sees "old OR new", not "sometimes
    // nothing", once the race is under way.
    expect((await put(original, seed)).status).toBe(204);

    const { observations, result: writerResults } = await runReadersAgainst(
      previewPath,
      scratchDir,
      READER_COUNT,
      () => Promise.all(candidates.map((body) => put(original, body))),
    );

    for (const res of writerResults) {
      expect(res.status).toBe(204);
    }

    // The must-have assertion: not ONE observation across the whole race was
    // a torn/partial/corrupt AVIF.
    expect(observations.length).toBeGreaterThan(0);
    const corrupt = observations.filter((o) => !o.ok);
    expect(corrupt).toEqual([]);

    // The file left behind is byte-identical to the seed or to exactly one of
    // the racing uploads — never some fifth, mangled thing.
    const final = Buffer.from(await readFile(previewPath));
    const isKnownCandidate = final.equals(seed) || candidates.some((c) => final.equals(c));
    expect(isKnownCandidate).toBe(true);
  });
});
