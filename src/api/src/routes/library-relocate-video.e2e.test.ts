/**
 * End-to-end video-relocation tests for POST /api/library/relocate (and
 * relocate-count), Mongo-gated (#1678).
 *
 * Split out of `library-relocate.e2e.test.ts` (file-size budget) — same
 * harness (temp library on disk + a real asset doc in a throwaway Mongo DB,
 * driven through the mounted route handler), scoped to the M5 full-name
 * video sidecar convention (`clip.mov` → `clip.mov.xmp`, NOT the image
 * stem-swap `clip.xmp`). Asserts the video + its full-name sidecar both
 * relocate crash-safely, and that a video's relocation never touches a
 * same-stem photo's own sidecar (the Live Photo pairing invariant
 * `xmpSidecarPath` exists to protect).
 *
 * Skips when MongoDB is unreachable (mirrors refile-backups.e2e.test.ts).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { Elysia } from 'elysia';
import { libraryRelocateRoutes } from './library-relocate.ts';
import { conflictCopyPath } from '../fs/xmp.ts';
import type { getDb } from '../db/client.ts';

// Unique test DB so a stray run never touches the real `maple` DB.
process.env.MAPLE_MONGO_DB = `maple_test_library_relocate_video_e2e_${process.pid}`;

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

describe('library-relocate end-to-end — video sidecars (#1678)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    const { setLibraryRootsForTests } = await import('../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('relocates a video + its full-name .mov.xmp sidecar into year/state/city, repoints DB, removes source', async () => {
    const db = await connectOrSkip('video+sidecar relocate');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.mov'), 'frames');
    // M5 full-name sidecar convention: `clip.mov.xmp`, NOT stem-swapped `clip.xmp`.
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.mov.xmp'), 'video-edits');

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
      // relocate-count now includes videos.
      const countRes = await postCount([`${SLUG}:${oldRel}/CLIP.mov`]);
      expect(countRes.status).toBe(200);
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(1);

      const res = await postRelocate([`${SLUG}:${oldRel}/CLIP.mov`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string; renamed?: boolean }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');
      expect(body.results[0]!.renamed).toBe(false);

      const newRel = '2024/California/Berkeley';
      // File + full-name sidecar both landed at the new dir with identical bytes.
      expect(await fs.readFile(path.join(dir, newRel, 'CLIP.mov'), 'utf8')).toBe('frames');
      expect(await fs.readFile(path.join(dir, newRel, 'CLIP.mov.xmp'), 'utf8')).toBe('video-edits');
      // Sources gone — neither the clip nor its sidecar is stranded.
      await expect(fs.stat(path.join(dir, oldRel, 'CLIP.mov'))).rejects.toThrow();
      await expect(fs.stat(path.join(dir, oldRel, 'CLIP.mov.xmp'))).rejects.toThrow();

      // DB repointed.
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(newRel);
      expect(doc?.fileinfo?.[0].filename).toBe('CLIP.mov');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('relocating a video does not touch a same-stem photo sidecar (Live Photo pairing safety)', async () => {
    const db = await connectOrSkip('video live-photo pairing safety');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-pair-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    // Live Photo pairing: same stem, two independent assets, two independent
    // sidecars (`IMG_1.xmp` for the still, `IMG_1.MOV.xmp` for the motion clip).
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.HEIC'), 'still-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'still-edits');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.MOV'), 'clip-frames');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.MOV.xmp'), 'clip-edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-video-pair-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_1.MOV',
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
      const res = await postRelocate([`${SLUG}:${oldRel}/IMG_1.MOV`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ ok: boolean; outcome?: string }>;
      };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');

      const newRel = '2024/California/Berkeley';
      // The clip + its own full-name sidecar moved.
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.MOV'), 'utf8')).toBe('clip-frames');
      expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.MOV.xmp'), 'utf8')).toBe('clip-edits');
      // The still photo and ITS sidecar were never touched — still at the old dir.
      expect(await fs.readFile(path.join(dir, oldRel, 'IMG_1.HEIC'), 'utf8')).toBe('still-pixels');
      expect(await fs.readFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'utf8')).toBe('still-edits');
    } finally {
      await assets.deleteOne({ _id });
    }
  });

  it('round-trips a video conflict-copy sidecar through write → relocate (#2481)', async () => {
    const db = await connectOrSkip('video conflict-copy relocate');
    if (!db) return;
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-conflict-'));
    await seedLibrary(libId, dir);

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    const movAbs = path.join(dir, oldRel, 'CLIP.MOV');
    await fs.writeFile(movAbs, 'frames');
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.MOV.xmp'), 'canonical-edits');
    // Write via the real conflictCopyPath — proves the writer and the relocate
    // matcher (listPairedSidecars) agree on the video's full-name base.
    const conflictAbs = conflictCopyPath(movAbs, 'MacBook');
    await fs.writeFile(conflictAbs, 'conflict-edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'relocate-video-conflict-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'CLIP.MOV',
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
      const res = await postRelocate([`${SLUG}:${oldRel}/CLIP.MOV`]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ ok: boolean; outcome?: string }> };
      expect(body.results[0]!.ok).toBe(true);
      expect(body.results[0]!.outcome).toBe('moved');

      const newRel = '2024/California/Berkeley';
      const newConflictPath = path.join(dir, newRel, 'CLIP.MOV (conflict from MacBook).xmp');
      expect(await fs.readFile(newConflictPath, 'utf8')).toBe('conflict-edits');
      // Source conflict copy gone — not stranded in the old folder.
      await expect(fs.stat(conflictAbs)).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
    }
  });
});
