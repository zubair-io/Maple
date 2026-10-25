/**
 * `.mapleignore` folder marker (#5398), end to end: the real sweep with the
 * real `handleEvent`, then the real missing-reaper, against a real SQLite
 * database and real files in a temporary library root.
 *
 * The property every case leans on is that the originals are never touched:
 * each test that excludes a folder re-reads the files (and a sidecar) and
 * compares bytes.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleEvent } from './handle-event.ts';
import { SweeperLoop, visitDirectory } from './sweeper.ts';
import * as frontier from './frontier.repo.ts';
import {
  assetIdAt,
  assetRow,
  createDiscoverLibrary,
  locationsOf,
  type DiscoverLibrary,
} from './discover.test-helpers.ts';
import { runMissingReaperOnce } from '../missing-reaper.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { trashAssetById } from '../../library/asset-trash.ts';
import { trashFolderRecursive } from '../../library/folder-trash.ts';
import { relocateAsset } from '../../library/relocate-asset.ts';
import { loadAssetLocationView } from '../../db/repos/assets.locations.repo.ts';
import { toObjectId } from '../../db/repos/values.ts';
import { readExif } from '../../indexer/exif.ts';
import { makeExifTiff } from './rename-reconcile.test-helpers.ts';

const LONG_AGO = '2000-01-01T00:00:00.000Z';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

/** Write a file whose bytes are unique to its name, so content-dedup keeps
 * distinct files distinct. */
function put(root: string, rel: string, content = `bytes of ${rel}`): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function mark(root: string, relDir: string): string {
  const marker = join(root, relDir, '.mapleignore');
  writeFileSync(marker, '');
  return marker;
}

/** One full sweep generation per call, through the production loop. */
async function sweeper(library: DiscoverLibrary): Promise<() => Promise<void>> {
  invalidateLibraryRoots();
  await frontier.seedRoot(library.folderId, library.root, 1);
  const loop = new SweeperLoop({
    folderId: library.folderId,
    root: library.root,
    startGen: 1,
    deps: { folderId: library.folderId, handleEvent },
    loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 0 }),
    sleep: async () => {},
  });
  return () => loop.runUntilIdleOrPaused();
}

/** A reaper pass that treats every tagged entry as aged out. */
function reapAged() {
  return runMissingReaperOnce({ deleteBeforeIso: FAR_FUTURE });
}

/** A reaper pass during which no tag has aged past the window yet. */
function reapInWindow() {
  return runMissingReaperOnce({ deleteBeforeIso: LONG_AGO });
}

function live(library: DiscoverLibrary, relDir: string, filename: string): boolean {
  const id = assetIdAt(library.db, relDir, filename);
  if (id === null) return false;
  const row = assetRow(library.db, id)!;
  const location = locationsOf(library.db, id).find(
    (l) => l.path === relDir && l.filename === filename,
  );
  return row.deleted_at === null && !!location && location.missing_since === null;
}

describe('.mapleignore — discovery', () => {
  it('never ingests a marked folder or anything nested under it', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    put(library.root, 'skip/b.jpg');
    put(library.root, 'skip/nested/deep/c.jpg');
    put(library.root, 'skip2/d.jpg');
    mark(library.root, 'skip');

    const sweep = await sweeper(library);
    await sweep();
    await sweep();

    expect(live(library, 'keep', 'a.jpg')).toBe(true);
    // A sibling whose name merely starts with the marked folder's is unaffected.
    expect(live(library, 'skip2', 'd.jpg')).toBe(true);
    expect(assetIdAt(library.db, 'skip', 'b.jpg')).toBeNull();
    expect(assetIdAt(library.db, 'skip/nested/deep', 'c.jpg')).toBeNull();
  });

  it('refuses created events under a marked folder from any producer', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    const file = put(library.root, 'skip/nested/b.jpg');
    mark(library.root, 'skip');

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    expect(assetIdAt(library.db, 'skip/nested', 'b.jpg')).toBeNull();

    rmSync(join(library.root, 'skip', '.mapleignore'));
    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    expect(live(library, 'skip/nested', 'b.jpg')).toBe(true);
  });

  it('excludes the whole library when the marker sits at the root', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'a.jpg');
    put(library.root, 'sub/b.jpg');
    const sweep = await sweeper(library);
    await sweep();
    expect(live(library, '', 'a.jpg')).toBe(true);

    mark(library.root, '');
    await sweep();
    expect(live(library, '', 'a.jpg')).toBe(false);
    expect(live(library, 'sub', 'b.jpg')).toBe(false);
  });
});

describe('.mapleignore — an already-indexed folder', () => {
  it('leaves the library through the reaper while the originals stay byte-identical', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    const raw = put(library.root, 'skip/b.jpg');
    const nested = put(library.root, 'skip/nested/c.jpg');
    const sidecar = put(library.root, 'skip/b.xmp', '<x:xmpmeta>rating 5</x:xmpmeta>');
    const sweep = await sweeper(library);
    await sweep();
    const bId = assetIdAt(library.db, 'skip', 'b.jpg')!;
    const cId = assetIdAt(library.db, 'skip/nested', 'c.jpg')!;
    expect(live(library, 'skip', 'b.jpg')).toBe(true);
    const before = [raw, nested, sidecar].map((p) => readFileSync(p));

    const marker = mark(library.root, 'skip');
    await sweep();

    // Tagged exactly like a vanished file: per location, with its own reason.
    for (const id of [bId, cId]) {
      const [location] = locationsOf(library.db, id);
      expect(typeof location!.missing_since).toBe('string');
      expect(location!.missing_reason).toBe('mapleignore');
      expect(assetRow(library.db, id)!.live_location_count).toBe(0);
    }
    expect(live(library, 'keep', 'a.jpg')).toBe(true);

    // Inside the prune window the reaper must not "recover" a present file
    // that is under a marker.
    const inWindow = await reapInWindow();
    expect(inWindow.recovered).toBe(0);
    expect(live(library, 'skip', 'b.jpg')).toBe(false);

    // Aged out: the ordinary soft delete, and no near-match veto even though
    // the file is on disk under exactly its recorded name.
    const aged = await reapAged();
    expect(aged.reaped).toBe(2);
    expect(aged.skippedNameMismatch).toBe(0);
    expect(assetRow(library.db, bId)!.deleted_reason).toBe('reaped');
    expect(assetRow(library.db, cId)!.deleted_reason).toBe('reaped');

    // Nothing on disk moved or changed — originals, sidecar and marker alike.
    expect([raw, nested, sidecar].map((p) => readFileSync(p))).toEqual(before);
    expect(readFileSync(marker, 'utf8')).toBe('');

    // Steady state: a further sweep writes nothing.
    const changesBefore = library.db.query(`SELECT COUNT(*) AS n FROM asset_changes`).get();
    await sweep();
    expect(library.db.query(`SELECT COUNT(*) AS n FROM asset_changes`).get()).toEqual(
      changesBefore,
    );
  });

  it('refuses to trash an excluded location still inside the prune window', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    const raw = put(library.root, 'skip/b.jpg');
    const sweep = await sweeper(library);
    await sweep();
    const id = assetIdAt(library.db, 'skip', 'b.jpg')!;
    mark(library.root, 'skip');
    await sweep();
    const before = readFileSync(raw);

    // A stale client deleting the photo must not move the ignored original
    // into `.maple/trash/`.
    expect((await trashAssetById(toObjectId(id))).kind).toBe('no-location');
    expect(readFileSync(raw)).toEqual(before);
  });

  it('keeps a deduplicated asset live on its other copy and prunes only the ignored one', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/same.jpg', 'identical bytes');
    put(library.root, 'skip/same.jpg', 'identical bytes');
    const sweep = await sweeper(library);
    await sweep();
    const id = assetIdAt(library.db, 'keep', 'same.jpg')!;
    expect(assetIdAt(library.db, 'skip', 'same.jpg')).toBe(id);

    mark(library.root, 'skip');
    await sweep();
    expect(live(library, 'keep', 'same.jpg')).toBe(true);
    expect(live(library, 'skip', 'same.jpg')).toBe(false);

    const aged = await reapAged();
    expect(aged.prunedEntries).toBe(1);
    expect(aged.reaped).toBe(0);
    expect(locationsOf(library.db, id).map((l) => l.path)).toEqual(['keep']);
    expect(assetRow(library.db, id)!.deleted_at).toBeNull();
  });
});

describe('.mapleignore — removing the marker', () => {
  it('re-indexes a folder whose assets the reaper already soft-deleted', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    put(library.root, 'skip/nested/b.jpg');
    const sweep = await sweeper(library);
    await sweep();
    const id = assetIdAt(library.db, 'skip/nested', 'b.jpg')!;
    const marker = mark(library.root, 'skip');
    await sweep();
    await reapAged();
    expect(assetRow(library.db, id)!.deleted_reason).toBe('reaped');

    rmSync(marker);
    await sweep();

    // The same row revives (content-dedup), not a new one.
    expect(assetIdAt(library.db, 'skip/nested', 'b.jpg')).toBe(id);
    expect(live(library, 'skip/nested', 'b.jpg')).toBe(true);
    expect(assetRow(library.db, id)!.deleted_reason).toBeNull();
  });

  it('recovers locations still inside the prune window', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    put(library.root, 'skip/b.jpg');
    const sweep = await sweeper(library);
    await sweep();
    const marker = mark(library.root, 'skip');
    await sweep();
    expect(live(library, 'skip', 'b.jpg')).toBe(false);

    rmSync(marker);
    const summary = await reapInWindow();
    expect(summary.recovered).toBe(1);
    expect(live(library, 'skip', 'b.jpg')).toBe(true);
  });
});

describe('.mapleignore — library root availability', () => {
  it('never reads an unmounted (empty) root as ignored, and never reaps through it', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    const raw = put(library.root, 'skip/b.jpg');
    put(library.root, 'keep/a.jpg');
    const sweep = await sweeper(library);
    await sweep();
    mark(library.root, 'skip');
    await sweep();
    const id = assetIdAt(library.db, 'skip', 'b.jpg')!;
    const before = readFileSync(raw);

    // "Unmount": the root is still there but empty, as an unmounted mount
    // point is. Its contents are parked beside it, untouched.
    const parked = `${library.root}-parked`;
    renameSync(library.root, parked);
    mkdirSync(library.root);
    try {
      const summary = await reapAged();
      expect(summary.reaped).toBe(0);
      expect(summary.skippedMountOffline).toBeGreaterThan(0);
      expect(assetRow(library.db, id)!.deleted_at).toBeNull();

      // A sweep of the empty root tags nothing and ingests nothing.
      await sweep();
      expect(live(library, 'keep', 'a.jpg')).toBe(true);
    } finally {
      rmSync(library.root, { recursive: true, force: true });
      renameSync(parked, library.root);
    }
    expect(readFileSync(raw)).toEqual(before);
  });
});

describe('.mapleignore — a directory queued before its ancestor was marked', () => {
  it('runs no rename reconciliation: the sidecar stays put and the location is excluded', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    const bytes = makeExifTiff({ captureDate: '2024:06:01 12:00:00', serial: 'CAM-A-001' });
    const oldAbs = put(library.root, 'skip/sub/IMG_0001.dng');
    writeFileSync(oldAbs, bytes);
    const sweep = await sweeper(library);
    await sweep();
    const id = assetIdAt(library.db, 'skip/sub', 'IMG_0001.dng')!;
    // Stand in for the exif stage: the rename fingerprint reads this field.
    library.db.run(`UPDATE assets SET exif = json(?) WHERE id = ?`, [
      JSON.stringify(await readExif(oldAbs)),
      id,
    ]);
    const sidecar = put(library.root, 'skip/sub/IMG_0001.xmp', '<xmp>edited</xmp>');

    // The descendant is already on the frontier when the ancestor gains its
    // marker, and the photo is then renamed in place outside Maple.
    const subDir = join(library.root, 'skip', 'sub');
    await frontier.seedRoot(library.folderId, subDir, 99);
    mark(library.root, 'skip');
    rmSync(oldAbs);
    writeFileSync(join(subDir, 'renamed.dng'), bytes);

    const queued = await frontier.claimNextDir(library.folderId, 99, 60_000);
    expect(queued!.dir_path).toBe(subDir);
    await visitDirectory(queued!, library.root, { handleEvent, folderId: library.folderId });

    expect(readFileSync(sidecar, 'utf8')).toBe('<xmp>edited</xmp>');
    expect(() => readFileSync(join(subDir, 'renamed.xmp'))).toThrow();
    const [location] = locationsOf(library.db, id);
    expect(location!.filename).toBe('IMG_0001.dng');
    expect(assetIdAt(library.db, 'skip/sub', 'renamed.dng')).toBeNull();

    // The marked ancestor's own visit then excludes the location.
    await sweep();
    const [excluded] = locationsOf(library.db, id);
    expect(excluded!.filename).toBe('IMG_0001.dng');
    expect(excluded!.missing_reason).toBe('mapleignore');
    expect(readFileSync(sidecar, 'utf8')).toBe('<xmp>edited</xmp>');
  });
});

describe('.mapleignore — explicit-entry moves of an excluded original', () => {
  it('recursive trash of a parent folder leaves the ignored originals in place', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    const kept = put(library.root, 'parent/kept.jpg');
    const raw = put(library.root, 'parent/skip/b.jpg');
    const nested = put(library.root, 'parent/skip/nested/c.jpg');
    const sidecar = put(library.root, 'parent/skip/b.xmp', '<xmp>edited</xmp>');
    const sweep = await sweeper(library);
    await sweep();
    mark(library.root, 'parent/skip');
    await sweep();
    const before = [raw, nested, sidecar].map((p) => readFileSync(p));

    const summary = await trashFolderRecursive(library.folderId, library.root, 'parent');

    expect(summary.succeeded).toBe(1);
    expect(() => readFileSync(kept)).toThrow();
    expect([raw, nested, sidecar].map((p) => readFileSync(p))).toEqual(before);
    for (const [dir, name] of [
      ['parent/skip', 'b.jpg'],
      ['parent/skip/nested', 'c.jpg'],
    ] as const) {
      const id = assetIdAt(library.db, dir, name)!;
      expect(assetRow(library.db, id)!.deleted_at).toBeNull();
      expect(locationsOf(library.db, id)[0]!.missing_reason).toBe('mapleignore');
    }
  });

  it('refuses a relocate whose explicit entry is excluded', async () => {
    using library = await createDiscoverLibrary('maple-ignore-');
    put(library.root, 'keep/a.jpg');
    const raw = put(library.root, 'skip/b.jpg');
    const sweep = await sweeper(library);
    await sweep();
    mark(library.root, 'skip');
    await sweep();
    const id = toObjectId(assetIdAt(library.db, 'skip', 'b.jpg')!);
    const before = readFileSync(raw);
    const excluded = (await loadAssetLocationView(id))!.fileinfo[0]!;

    const outcome = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'keep',
      activeFileInfoOverride: excluded,
    });

    expect(outcome.kind).toBe('error');
    expect(readFileSync(raw)).toEqual(before);
    expect(() => readFileSync(join(library.root, 'keep', 'b.jpg'))).toThrow();
  });
});
