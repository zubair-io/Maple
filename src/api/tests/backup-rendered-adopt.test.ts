/**
 * #4695: the rendered-companion upload must never adopt a file it did not
 * write unless that file is provably the same companion. Adopting an
 * unrelated file recorded it as the asset's companion, and purging the photo
 * from Trash later deleted it. The Live Photo `.mov` twin these tests upload
 * is recorded in `apple_live_video_path` (#5243).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ObjectId } from '../src/db/object-id.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  findAssetIdByMapleId,
  readAsset,
  seedBackupAsset,
  seedLibrary,
} from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { resolvePurgeCompanion } from '../src/library/purge-rendered-companion.ts';
import { assetOwnsRelPath } from '../src/db/repos/assets.location-owner.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const deviceId = 'adopt-device';
const photoMapleId = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const photoRel = '2024/LivePhotos/IMG_0001.HEIC';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

beforeEach(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-rendered-adopt-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, { path: tmpLib, label: 'adopt-test' });
  invalidateLibraryRoots();
  await fs.mkdir(path.join(tmpLib, '2024', 'LivePhotos'), { recursive: true });
  await fs.writeFile(path.join(tmpLib, photoRel), Buffer.alloc(64, 1));
  seedBackupAsset(live.db, {
    mapleId: photoMapleId,
    size: 64,
    locations: [{ libraryId: libId, relPath: photoRel }],
    links: [{ deviceId, phassetLocalId: 'ADOPT/1' }],
  });
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

async function uploadLiveTwin(bytes: Buffer, device = deviceId): Promise<string> {
  const res = await authedHandle(
    new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/rendered`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Maple-Device-Id': device,
        'X-Maple-Phasset-Id': 'ADOPT/1',
        'X-Maple-Target-Rel-Path': photoRel,
        'X-Maple-Suffix-Override': 'mov',
        'X-Maple-Total-Bytes': String(bytes.byteLength),
        'X-Maple-Maple-Id': photoMapleId,
        'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      },
      body: new Uint8Array(bytes),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { target_rel_path: string }).target_rel_path;
}

function recordedCompanion(): string | undefined {
  const id = findAssetIdByMapleId(live.db, photoMapleId);
  const asset = readAsset(live.db, id!);
  expect(asset?.apple_rendered_path ?? null).toBeNull();
  return asset?.apple_live_video_path as string | undefined;
}

describe('rendered companion placement (#4695)', () => {
  test('an unrelated file already at the target is neither adopted nor overwritten', async () => {
    const unrelated = path.join(tmpLib, '2024/LivePhotos/IMG_0001.mov');
    await fs.writeFile(unrelated, 'someone-elses-video');
    const twin = Buffer.from('the-live-photo-twin');

    const placed = await uploadLiveTwin(twin);

    expect(placed).not.toBe('2024/LivePhotos/IMG_0001.mov');
    expect(recordedCompanion()).toBe(placed);
    expect(await fs.readFile(unrelated, 'utf8')).toBe('someone-elses-video');
    expect(await fs.readFile(path.join(tmpLib, placed), 'utf8')).toBe('the-live-photo-twin');
  });

  test("another asset's original under a case alias of the target is never claimed", async () => {
    const videoRel = '2024/LivePhotos/IMG_0001.MOV';
    await fs.writeFile(path.join(tmpLib, videoRel), 'unrelated-video-asset');
    seedBackupAsset(live.db, {
      mapleId: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
      size: 21,
      locations: [{ libraryId: libId, relPath: videoRel }],
      links: [{ deviceId, phassetLocalId: 'ADOPT/VIDEO' }],
    });

    const placed = await uploadLiveTwin(Buffer.from('the-live-photo-twin'));

    expect(placed.toLowerCase()).not.toBe(videoRel.toLowerCase());
    expect(recordedCompanion()).toBe(placed);
    expect(await fs.readFile(path.join(tmpLib, videoRel), 'utf8')).toBe('unrelated-video-asset');
  });

  test('the same companion already at the target (another device won the race) is adopted', async () => {
    const twin = Buffer.from('the-live-photo-twin');
    await fs.writeFile(path.join(tmpLib, '2024/LivePhotos/IMG_0001.mov'), twin);

    const placed = await uploadLiveTwin(twin);

    expect(placed).toBe('2024/LivePhotos/IMG_0001.mov');
    expect(recordedCompanion()).toBe(placed);
    const siblings = await fs.readdir(path.join(tmpLib, '2024/LivePhotos'));
    expect(siblings.filter((name) => name.toLowerCase().endsWith('.mov'))).toHaveLength(1);
  });
});

describe('Trash purge companion guard (#4695)', () => {
  test("a companion path that is another asset's location is never returned for deletion", async () => {
    const videoRel = '2024/LivePhotos/IMG_0001.MOV';
    await fs.writeFile(path.join(tmpLib, videoRel), 'unrelated-video-asset');
    seedBackupAsset(live.db, {
      mapleId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      size: 21,
      locations: [{ libraryId: libId, relPath: videoRel }],
      links: [{ deviceId, phassetLocalId: 'ADOPT/VIDEO2' }],
    });
    const canonical = await fs.realpath(tmpLib);

    const target = await resolvePurgeCompanion(tmpLib, videoRel, path.join(canonical, photoRel));
    expect(target).toBeNull();
  });

  test('a genuine companion no asset owns is still returned', async () => {
    const companionRel = '2024/LivePhotos/IMG_0001.rendered.HEIC';
    await fs.writeFile(path.join(tmpLib, companionRel), 'rendered');
    const canonical = await fs.realpath(tmpLib);

    const target = await resolvePurgeCompanion(
      tmpLib,
      companionRel,
      path.join(canonical, photoRel),
    );
    expect(target).toBe(path.join(canonical, companionRel));
  });
});

describe('rendered companion review follow-ups (#4695)', () => {
  test('a second device reuses the identical companion already at the disambiguated name', async () => {
    await fs.writeFile(path.join(tmpLib, '2024/LivePhotos/IMG_0001.mov'), 'someone-elses-video');
    const twin = Buffer.from('the-live-photo-twin');

    const first = await uploadLiveTwin(twin, 'device-a');
    const second = await uploadLiveTwin(twin, 'device-b');

    expect(second).toBe(first);
    expect(recordedCompanion()).toBe(first);
    const movs = (await fs.readdir(path.join(tmpLib, '2024/LivePhotos'))).filter((name) =>
      name.toLowerCase().endsWith('.mov'),
    );
    expect(movs).toHaveLength(2);
  });

  test('a retry of a completed disambiguated upload returns where the companion landed', async () => {
    await fs.writeFile(path.join(tmpLib, '2024/LivePhotos/IMG_0001.mov'), 'someone-elses-video');
    const twin = Buffer.from('the-live-photo-twin');

    const placed = await uploadLiveTwin(twin);
    const retried = await uploadLiveTwin(twin);

    expect(placed).not.toBe('2024/LivePhotos/IMG_0001.mov');
    expect(retried).toBe(placed);
  });

  test('ownership matches a non-ASCII case alias of an indexed filename', async () => {
    seedBackupAsset(live.db, {
      mapleId: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d',
      size: 5,
      locations: [{ libraryId: libId, relPath: '2024/LivePhotos/Ünterwegs.MOV' }],
      links: [{ deviceId, phassetLocalId: 'ADOPT/UNICODE' }],
    });

    expect(await assetOwnsRelPath(libId, '2024/LivePhotos/ünterwegs.mov')).toBe(true);
    expect(await assetOwnsRelPath(libId, '2024/LivePhotos/u\u0308nterwegs.mov')).toBe(true);
    expect(await assetOwnsRelPath(libId, '2024/LivePhotos/anderswo.mov')).toBe(false);
  });

  test('the ownership lookup seeks the folder through the location index', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const recording = {
      ...live.handle,
      read: (sql: string, params?: unknown[]) => {
        seen.push({ sql, params: params ?? [] });
        return live.handle.read(sql, params as never);
      },
    } as typeof live.handle;
    await assetOwnsRelPath(libId, '2024/LivePhotos/IMG_0001.mov', recording);
    expect(seen).toHaveLength(1);
    const plan = live.db
      .query(`EXPLAIN QUERY PLAN ${seen[0]!.sql}`)
      .all(...(seen[0]!.params as never[])) as { detail: string }[];
    expect(plan.map((row) => row.detail).join(' ')).toContain('path=?');
  });
});
