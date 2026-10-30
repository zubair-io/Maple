/**
 * End-to-end Live Photo tests for POST /api/library/relocate (and
 * relocate-count) — #5543, part of #5448.
 *
 * Same harness as the other `library-relocate` suites: a temp library on disk
 * and real assets in an in-memory SQLite database, driven through the mounted
 * route handler. A still and a clip are two assets; they are one Live Photo only
 * when the `live-photo` stage recorded the same Apple content identifier on both
 * (`live_content_id`), and only then does the clip travel with its still.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  SLUG,
  clearLibraryCache,
  locationOf,
  postCount,
  postRelocate,
  seedRelocatableAsset,
  usPlaceText,
} from './library-relocate.test-helpers.ts';

interface RelocateResult {
  address: string;
  ok: boolean;
  outcome?: string;
  renamed?: boolean;
  error?: string;
}

const OLD_REL = '2024/Loose';
const BERKELEY_REL = '2024/California/Berkeley';

async function resultsOf(res: Response): Promise<RelocateResult[]> {
  return ((await res.json()) as { results: RelocateResult[] }).results;
}

async function countOf(addresses: string[]): Promise<number> {
  return ((await (await postCount(addresses)).json()) as { count: number }).count;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

describe('library-relocate end-to-end — Live Photo clip (#5543)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  async function stageFolder(prefix: string, files: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dir = root;
    await fs.mkdir(path.join(root, ...OLD_REL.split('/')), { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, body]) =>
        fs.writeFile(path.join(root, OLD_REL, name), body),
      ),
    );
    return root;
  }

  it('moves the identifier-paired clip and its sidecar into the still’s folder', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-pair-', {
      'IMG_1.HEIC': 'still-pixels',
      'IMG_1.xmp': 'still-edits',
      'IMG_1.MOV': 'clip-frames',
      'IMG_1.MOV.xmp': 'clip-edits',
    });
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_1.HEIC',
      mapleId: 'live-still-id',
      metadataOverride: usPlaceText(),
      liveContentId: 'ABCD-1234',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_1.MOV',
      mapleId: 'live-clip-id',
      libraryId: still.libraryId,
      liveContentId: 'ABCD-1234',
    });

    expect(await countOf([`${SLUG}:${OLD_REL}/IMG_1.HEIC`])).toBe(1);

    const res = await postRelocate([`${SLUG}:${OLD_REL}/IMG_1.HEIC`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, outcome: 'moved' });

    expect(await fs.readFile(path.join(root, BERKELEY_REL, 'IMG_1.HEIC'), 'utf8')).toBe(
      'still-pixels',
    );
    expect(await fs.readFile(path.join(root, BERKELEY_REL, 'IMG_1.xmp'), 'utf8')).toBe(
      'still-edits',
    );
    expect(await fs.readFile(path.join(root, BERKELEY_REL, 'IMG_1.MOV'), 'utf8')).toBe(
      'clip-frames',
    );
    expect(await fs.readFile(path.join(root, BERKELEY_REL, 'IMG_1.MOV.xmp'), 'utf8')).toBe(
      'clip-edits',
    );
    expect(await exists(path.join(root, OLD_REL, 'IMG_1.MOV'))).toBe(false);
    expect(await exists(path.join(root, OLD_REL, 'IMG_1.MOV.xmp'))).toBe(false);

    expect(locationOf(live.db, still.assetId)).toMatchObject({
      path: BERKELEY_REL,
      filename: 'IMG_1.HEIC',
    });
    expect(locationOf(live.db, clip.assetId)).toMatchObject({
      path: BERKELEY_REL,
      filename: 'IMG_1.MOV',
    });
  });

  it('moves a pair once when both halves are selected, and counts it once', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-both-', {
      'IMG_2.HEIC': 'still-pixels',
      'IMG_2.MOV': 'clip-frames',
    });
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_2.HEIC',
      mapleId: 'live-both-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-2',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_2.MOV',
      mapleId: 'live-both-clip',
      libraryId: still.libraryId,
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-2',
    });
    const both = [`${SLUG}:${OLD_REL}/IMG_2.HEIC`, `${SLUG}:${OLD_REL}/IMG_2.MOV`];

    expect(await countOf(both)).toBe(1);

    const results = await resultsOf(await postRelocate(both));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, outcome: 'moved' });
    expect(locationOf(live.db, still.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, clip.assetId)?.path).toBe(BERKELEY_REL);
  });

  it('follows the still rather than its own geo', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-follow-', {
      'IMG_3.HEIC': 'still-pixels',
      'IMG_3.MOV': 'clip-frames',
    });
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_3.HEIC',
      mapleId: 'live-follow-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-3',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_3.MOV',
      mapleId: 'live-follow-clip',
      libraryId: still.libraryId,
      metadataOverride: {
        ...usPlaceText(),
        place_text: { city: 'Paris', country: 'France', country_code: 'fr' },
      },
      liveContentId: 'LIVE-PAIR-3',
    });

    await postRelocate([`${SLUG}:${OLD_REL}/IMG_3.HEIC`, `${SLUG}:${OLD_REL}/IMG_3.MOV`]);

    expect(locationOf(live.db, still.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, clip.assetId)?.path).toBe(BERKELEY_REL);
  });

  it('leaves a same-stem clip with a different or missing identifier where it is', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-unpaired-', {
      'IMG_4.HEIC': 'still-pixels',
      'IMG_4.MOV': 'other-clip',
      'IMG_5.HEIC': 'second-still',
      'IMG_5.MOV': 'unindexed-clip',
    });
    const stillMismatch = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_4.HEIC',
      mapleId: 'live-unpaired-still-4',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-ID-A',
    });
    const clipMismatch = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_4.MOV',
      mapleId: 'live-unpaired-clip-4',
      libraryId: stillMismatch.libraryId,
      liveContentId: 'LIVE-ID-B',
    });
    const stillNoId = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_5.HEIC',
      mapleId: 'live-unpaired-still-5',
      libraryId: stillMismatch.libraryId,
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-ID-C',
    });
    const clipNoId = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_5.MOV',
      mapleId: 'live-unpaired-clip-5',
      libraryId: stillMismatch.libraryId,
    });

    const results = await resultsOf(
      await postRelocate([`${SLUG}:${OLD_REL}/IMG_4.HEIC`, `${SLUG}:${OLD_REL}/IMG_5.HEIC`]),
    );

    expect(results).toHaveLength(2);
    expect(locationOf(live.db, stillMismatch.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, stillNoId.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, clipMismatch.assetId)?.path).toBe(OLD_REL);
    expect(locationOf(live.db, clipNoId.assetId)?.path).toBe(OLD_REL);
    expect(await exists(path.join(root, OLD_REL, 'IMG_4.MOV'))).toBe(true);
    expect(await exists(path.join(root, OLD_REL, 'IMG_5.MOV'))).toBe(true);
  });

  it('keeps a paired clip where it is when its still is already in the right folder', async () => {
    using live = await createLiveTestDatabase();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-live-settled-'));
    dir = root;
    await fs.mkdir(path.join(root, ...BERKELEY_REL.split('/')), { recursive: true });
    await fs.writeFile(path.join(root, BERKELEY_REL, 'IMG_6.HEIC'), 'still-pixels');
    await fs.writeFile(path.join(root, BERKELEY_REL, 'IMG_6.MOV'), 'clip-frames');
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: BERKELEY_REL,
      filename: 'IMG_6.HEIC',
      mapleId: 'live-settled-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-6',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: BERKELEY_REL,
      filename: 'IMG_6.MOV',
      mapleId: 'live-settled-clip',
      libraryId: still.libraryId,
      liveContentId: 'LIVE-PAIR-6',
    });
    const both = [`${SLUG}:${BERKELEY_REL}/IMG_6.HEIC`, `${SLUG}:${BERKELEY_REL}/IMG_6.MOV`];

    expect(await countOf(both)).toBe(0);

    const results = await resultsOf(await postRelocate(both));
    expect(results.every((result) => result.outcome !== 'moved')).toBe(true);
    expect(locationOf(live.db, clip.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, still.assetId)?.path).toBe(BERKELEY_REL);
  });

  it('never relocates a paired clip on its own when only the clip is selected', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-clip-only-', {
      'IMG_7.HEIC': 'still-pixels',
      'IMG_7.MOV': 'clip-frames',
    });
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_7.HEIC',
      mapleId: 'live-clip-only-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-7',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_7.MOV',
      mapleId: 'live-clip-only-clip',
      libraryId: still.libraryId,
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-7',
    });
    const clipOnly = [`${SLUG}:${OLD_REL}/IMG_7.MOV`];

    expect(await countOf(clipOnly)).toBe(0);

    expect(await resultsOf(await postRelocate(clipOnly))).toHaveLength(0);
    expect(locationOf(live.db, clip.assetId)?.path).toBe(OLD_REL);
    expect(locationOf(live.db, still.assetId)?.path).toBe(OLD_REL);
  });

  it('reports a clip that cannot move without undoing the still that did', async () => {
    using live = await createLiveTestDatabase();
    const root = await stageFolder('relocate-live-clip-fails-', {
      'IMG_8.HEIC': 'still-pixels',
      'IMG_9.HEIC': 'next-still',
      'IMG_9.MOV': 'next-clip',
    });
    const still = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_8.HEIC',
      mapleId: 'live-fails-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-8',
    });
    const clip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_8.MOV',
      mapleId: 'live-fails-clip',
      libraryId: still.libraryId,
      liveContentId: 'LIVE-PAIR-8',
    });
    const next = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_9.HEIC',
      mapleId: 'live-fails-next',
      libraryId: still.libraryId,
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-9',
    });
    const nextClip = seedRelocatableAsset(live.db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_9.MOV',
      mapleId: 'live-fails-next-clip',
      libraryId: still.libraryId,
      liveContentId: 'LIVE-PAIR-9',
    });

    const res = await postRelocate([
      `${SLUG}:${OLD_REL}/IMG_8.HEIC`,
      `${SLUG}:${OLD_REL}/IMG_9.HEIC`,
    ]);
    const results = await resultsOf(res);

    expect(res.status).toBe(207);
    expect(locationOf(live.db, still.assetId)?.path).toBe(BERKELEY_REL);
    expect(await exists(path.join(root, BERKELEY_REL, 'IMG_8.HEIC'))).toBe(true);
    expect(locationOf(live.db, clip.assetId)?.path).toBe(OLD_REL);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ address: `${SLUG}:${OLD_REL}/IMG_8.MOV` }),
    ]);
    expect(locationOf(live.db, next.assetId)?.path).toBe(BERKELEY_REL);
    expect(locationOf(live.db, nextClip.assetId)?.path).toBe(BERKELEY_REL);
  });
});
