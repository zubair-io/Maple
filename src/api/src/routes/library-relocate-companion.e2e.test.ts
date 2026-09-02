/**
 * End-to-end tests for POST /api/library/relocate covering the two
 * behaviors `moveBackupAsset` had that the generic `relocateAsset`
 * primitive didn't, before #2667 generalized the Apple-rendered companion
 * onto it and kept the dedupe short-circuit as a caller-side pre-check
 * (`library/relocate-geo.ts`):
 *
 *   1. The `apple_rendered_path` companion travels alongside the primary +
 *      sidecar, base-swap renamed the same way, and the DB field is
 *      repointed to its new location.
 *   2. A byte-identical, companion-free destination collapses to a dedupe
 *      (repoint + delete source, no copy) — the pre-existing destination
 *      survives with its OWN bytes untouched, and the response still
 *      reports `outcome: 'moved'` (the route's public JSON contract, which
 *      `moveBackupAsset` also reported for a dedupe).
 *
 * Split out of `library-relocate.e2e.test.ts` to keep that file under its
 * file-size budget headroom, the same reason `library-relocate-video.e2e.test.ts`
 * is its own file. Skips when MongoDB is unreachable.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { Elysia } from 'elysia';
import { libraryRelocateRoutes } from './library-relocate.ts';
import type { getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

withTestDb(`maple_test_library_relocate_companion_e2e_${process.pid}`);

const app = new Elysia().use(libraryRelocateRoutes);

const SLUG = 'photos';

async function connectOrSkip(label: string): Promise<Awaited<ReturnType<typeof getDb>> | null> {
  try {
    const { getDb } = await import('../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

async function seedLibrary(libId: ObjectId, root: string): Promise<void> {
  const { setLibraryRootsForTests, setLibraryBySlugForTests } =
    await import('../indexer/libraries.cache.ts');
  setLibraryRootsForTests(new Map([[libId.toHexString(), root]]));
  setLibraryBySlugForTests(SLUG, { libraryId: libId, root, label: 'Photos' });
}

function usPlaceText() {
  return {
    edited_at: new Date().toISOString(),
    touched_fields: ['place_text'],
    place_text: {
      city: 'Berkeley',
      state: 'California',
      country: 'United States',
      country_code: 'us',
    },
  };
}

async function postRelocate(addresses: string[]): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/library/relocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    }),
  );
}

beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

describe('library-relocate end-to-end — companion + dedupe (#2667)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    const { setLibraryRootsForTests } = await import('../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('carries the apple_rendered_path companion alongside the primary + sidecar and repoints the DB field', async () => {
    const db = await connectOrSkip('apple_rendered_path companion relocate');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-companion-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.dng'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.xmp'), 'edits');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.jpg'), 'apple-rendered-bytes');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-companion-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_5.dng',
          library_id: libId,
          deleted_at: null,
          missing_since: null,
        },
      ],
      apple_rendered_path: `${oldRel}/IMG_5.jpg`,
      metadata_override: usPlaceText(),
      exif: { captured_year: 2024 },
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_5.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');

      const newRel = '2024/California/Berkeley';
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.dng'), 'utf8')).toBe('pixels');
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.xmp'), 'utf8')).toBe('edits');
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.jpg'), 'utf8')).toBe(
        'apple-rendered-bytes',
      );
      // Sources gone.
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_5.dng'))).rejects.toThrow();
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_5.jpg'))).rejects.toThrow();

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        apple_rendered_path?: string | null;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.apple_rendered_path).toBe(`${newRel}/IMG_5.jpg`);
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('a byte-identical, companion-free destination dedupes: repoint + delete source, occupant survives', async () => {
    const db = await connectOrSkip('byte-identical dedupe');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-dedupe-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    // Source and the pre-existing occupant are BYTE-IDENTICAL, and the
    // source has no sidecar/companion — the dedupe condition.
    await fs.writeFile(path.join(dir, oldRel, 'IMG_6.dng'), 'identical-pixels');
    await fs.writeFile(path.join(dir, newRel, 'IMG_6.dng'), 'identical-pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-dedupe-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_6.dng',
          library_id: libId,
          deleted_at: null,
          missing_since: null,
        },
      ],
      metadata_override: usPlaceText(),
      exif: { captured_year: 2024 },
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_6.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');
      // No auto-suffix — the destination filename is unchanged, it's a dedupe.
      expect(body.results[0]!.renamed).toBe(false);

      // Occupant survives, filename NOT suffixed (no second copy created).
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_6.dng'), 'utf8')).toBe(
        'identical-pixels',
      );
      await expect(fs.stat(path.join(dir, newRel, 'IMG_6.1.dng'))).rejects.toThrow();
      // Source gone.
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_6.dng'))).rejects.toThrow();

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_6.dng');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('a byte-identical destination but the source carries a sidecar never dedupes — falls through to rename', async () => {
    const db = await connectOrSkip('dedupe declined when source has a sidecar');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-nodedupe-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_7.dng'), 'identical-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_7.xmp'), 'edits-must-not-be-dropped');
    await fs.writeFile(path.join(dir, newRel, 'IMG_7.dng'), 'identical-pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-nodedupe-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_7.dng',
          library_id: libId,
          deleted_at: null,
          missing_since: null,
        },
      ],
      metadata_override: usPlaceText(),
      exif: { captured_year: 2024 },
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_7.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');
      // Edits-safety: never dedupe a source carrying a sidecar — auto-suffix instead.
      expect(body.results[0]!.renamed).toBe(true);
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.1.dng'), 'utf8')).toBe(
        'identical-pixels',
      );
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.1.xmp'), 'utf8')).toBe(
        'edits-must-not-be-dropped',
      );
      // Pre-existing occupant untouched.
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.dng'), 'utf8')).toBe(
        'identical-pixels',
      );
    } finally {
      await assets.deleteOne({ _id });
    }
  });
});
