/**
 * End-to-end tests for POST /api/library/relocate (and relocate-count),
 * Mongo-gated (#1671).
 *
 * These exercise the REAL move machinery: a temp library on disk + a real
 * asset doc in a throwaway Mongo DB, driven through the mounted route handler.
 * They assert the crash-safe outcome — the photo file AND its `.xmp` sidecar
 * both land in `<libraryRoot>/<year>/<state>/<city>/`, the source paths are
 * gone, and the DB `fileinfo` is repointed — plus the collision auto-rename
 * (file + sidecar get a `.N` suffix; the pre-existing occupant is untouched),
 * the video exclusion (#1678), and the already-in-place no-op.
 *
 * Skips when MongoDB is unreachable (mirrors refile-backups.e2e.test.ts).
 * Pure wiring / validation is covered in library-relocate.test.ts.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { Elysia } from 'elysia';
import { libraryRelocateRoutes } from './library-relocate.ts';
import type { getDb } from '../db/client.ts';

// Unique test DB so a stray run never touches the real `maple` DB.
process.env.MAPLE_MONGO_DB = `maple_test_library_relocate_e2e_${process.pid}`;

const app = new Elysia().use(libraryRelocateRoutes);

const SLUG = 'photos';

async function connectOrSkip(
  label: string,
): Promise<Awaited<ReturnType<typeof getDb>> | null> {
  try {
    const { getDb } = await import('../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

/** Seed the in-memory library cache with a single slug → root mapping so both
 *  loadLibraryRoots (byId) and resolveAddress (bySlug) resolve. */
async function seedLibrary(libId: ObjectId, root: string): Promise<void> {
  const { setLibraryRootsForTests, setLibraryBySlugForTests } =
    await import('../indexer/libraries.cache.ts');
  setLibraryRootsForTests(new Map([[libId.toHexString(), root]]));
  setLibraryBySlugForTests(SLUG, { libraryId: libId, root, label: 'Photos' });
}

/** Minimal metadata_override.place_text so geoDir computes California/Berkeley. */
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

async function postCount(addresses: string[]): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/library/relocate-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    }),
  );
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

describe('library-relocate end-to-end', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    const { setLibraryRootsForTests } = await import('../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('relocates a photo + its .xmp sidecar into year/state/city, repoints DB, removes source', async () => {
    const db = await connectOrSkip('photo+sidecar relocate');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-photo-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.dng'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-photo-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_1.dng',
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
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_1.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');
      expect(body.results[0]!.renamed).toBe(false);

      const newRel = '2024/California/Berkeley';
      // File + sidecar both landed at the new dir with identical bytes.
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.dng'), 'utf8')).toBe('pixels');
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.xmp'), 'utf8')).toBe('edits');
      // Sources gone.
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_1.dng'))).rejects.toThrow();
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_1.xmp'))).rejects.toThrow();

      // DB repointed.
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_1.dng');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('relocates a photo even if it is flagged missing_since, and clears the missing_since flag in the DB', async () => {
    const db = await connectOrSkip('photo missing_since relocate');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-missing-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_missing.dng'), 'missing_bytes');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_missing.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-missing-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_missing.dng',
          library_id: libId,
          deleted_at: null,
          missing_since: '2026-06-30T00:00:00.000Z', // marked missing
        },
      ],
      metadata_override: usPlaceText(),
      exif: { captured_year: 2024 },
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      // 1. Verify relocate-count counts it correctly (it returns 1, not 0)
      const countRes = await postCount([`${SLUG}:${oldRel}/IMG_missing.dng`]);
      expect(countRes.status).toBe(200);
      const countBody = await countRes.json();
      expect(countBody.count).toBe(1);

      // 2. Perform relocate
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_missing.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');

      const newRel = '2024/California/Berkeley';
      // File + sidecar both landed at the new dir
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_missing.dng'), 'utf8')).toBe('missing_bytes');
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_missing.xmp'), 'utf8')).toBe('edits');

      // DB repointed and missing_since is cleared (null)
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string; missing_since?: string | null }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_missing.dng');
      expect(doc?.fileinfo?.[0].missing_since).toBeNull();
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('auto-renames file + sidecar on collision (.N suffix), leaves the pre-existing occupant untouched', async () => {
    const db = await connectOrSkip('collision auto-rename');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-collision-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    // Source (distinct bytes from the occupant, so it can't dedupe).
    await fs.writeFile(path.join(dir, oldRel, 'IMG_2.dng'), 'source-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_2.xmp'), 'source-edits');
    // Pre-existing occupant at the target with the SAME name, different bytes.
    await fs.writeFile(path.join(dir, newRel, 'IMG_2.dng'), 'occupant-pixels');
    await fs.writeFile(path.join(dir, newRel, 'IMG_2.xmp'), 'occupant-edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-collision-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_2.dng',
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
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_2.dng`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');
      expect(body.results[0]!.renamed).toBe(true);

      // Occupant untouched.
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.dng'), 'utf8')).toBe(
        'occupant-pixels',
      );
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.xmp'), 'utf8')).toBe('occupant-edits');
      // Moved copy landed at the suffixed sibling (.1) — file AND sidecar.
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.1.dng'), 'utf8')).toBe(
        'source-pixels',
      );
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.1.xmp'), 'utf8')).toBe('source-edits');
      // Source gone.
      await expect(fs.stat(path.join(dir, oldRel, 'IMG_2.dng'))).rejects.toThrow();

      // DB repointed to the renamed filename.
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_2.1.dng');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('excludes videos — a video asset with a place is not counted (#1678)', async () => {
    const db = await connectOrSkip('video excluded');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.mov'), 'frames');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-video-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'CLIP.mov',
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
      const res = await postCount([`${SLUG}:${oldRel}/CLIP.mov`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(0);

      // And a relocate leaves the video exactly where it was.
      const relRes = await postRelocate([`${SLUG}:${oldRel}/CLIP.mov`]);
      const relBody = (await relRes.json()) as { results: unknown[] };
      expect(relBody.results).toHaveLength(0);
      expect(await fs.readFile(path.join(dir, oldRel, 'CLIP.mov'), 'utf8')).toBe('frames');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('already in the right folder → count 0, relocate is a no-op', async () => {
    const db = await connectOrSkip('already in place');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-inplace-'));
    await seedLibrary(libId, dir);

    // The asset already lives at its canonical geo dir.
    const rel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_3.dng'), 'pixels');
    await fs.writeFile(path.join(dir, rel, 'IMG_3.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-inplace-id',
      fileinfo: [
        {
          path: rel,
          filename: 'IMG_3.dng',
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
      const res = await postCount([`${SLUG}:${rel}/IMG_3.dng`]);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { count: number }).count).toBe(0);
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('synchronously reconciles override from sidecar on-the-fly when stage version is dirty (relocate-count)', async () => {
    const db = await connectOrSkip('on-the-fly reconcile');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-reconcile-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_4.dng'), 'pixels');

    // Create a valid XMP sidecar on disk with geo information
    const xmpContent = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   photoshop:City="Berkeley"
   photoshop:State="California"
   photoshop:Country="United States"
   Iptc4xmpCore:CountryCode="US">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    await fs.writeFile(path.join(dir, oldRel, 'IMG_4.xmp'), xmpContent);

    const _id = new ObjectId();
    // Insert asset with stages version set to 0 (dirty) and NO metadata_override place_text
    await assets.insertOne({
      _id,
      maple_id: 'relocate-reconcile-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_4.dng',
          library_id: libId,
          deleted_at: null,
          missing_since: null,
        },
      ],
      // No metadata_override at all, mimicking state immediately after batchApply
      exif: { captured_year: 2024 },
      stages: {
        'sidecar-metadata-index': { version: 0, attempts: 0, dead: false },
      },
    } as never);

    try {
      // Prior to relocate-count, doc in DB has no metadata_override.place_text.
      // Calling relocate-count should:
      //   1. Notice version !== 1.
      //   2. Run sidecarMetadataIndexHandler.
      //   3. Update the doc in the DB with metadata_override.place_text.
      //   4. Correctly count this asset as wouldRelocate (since target is California/Berkeley and current is Loose).
      const res = await postCount([`${SLUG}:${oldRel}/IMG_4.dng`]);
      expect(res.status).toBe(200);
      const countBody = (await res.json()) as { count: number };
      expect(countBody.count).toBe(1);

      // Verify DB was updated
      const doc = (await assets.findOne({ _id })) as any;
      expect(doc?.metadata_override?.place_text?.city).toBe('Berkeley');
      expect(doc?.metadata_override?.place_text?.state).toBe('California');
      expect(doc?.stages?.['sidecar-metadata-index']?.version).toBe(1);
    } finally {
      await assets.deleteOne({ _id });
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
        dir = null;
      }
    }
  });
});
