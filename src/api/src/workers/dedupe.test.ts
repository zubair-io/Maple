/**
 * DeDuplicate worker integration tests — real SQLite, real filesystem (#3787).
 *
 * The worker's whole job is to move files a photographer owns, so nothing here
 * is mocked below the decision it is testing: every case seeds actual bytes
 * under a temporary library root, runs a real pass, and then asserts on both
 * what is on disk and what the database now says.
 *
 * Each test opens its own database and installs it as the process-wide handle
 * (`createLiveTestDatabase`), because `runDeDuplicateOnce` reaches `sqliteDb()`
 * with no override — it is a worker tick, not a repository call. That also
 * means each test gets its own temporary library root, its own `folders` row,
 * and no way to see another test's fixtures; `using` disposes both even when an
 * assertion throws partway through.
 *
 * Covers: collapse-to-one with the keeper ranking, file + sidecar relocation
 * into `_duplicates/`, removal of the moved location rows, cache cleanup of the
 * moved copy's folder, cache-stage re-arm when the anchor moves, live-only
 * gating (tombstoned siblings ignored), missing-file skip, `.keep` pinning, and
 * dry-run.
 *
 * One conversion note: on Mongo the candidate gate needed a partial index on
 * `fileinfo.1` plus an in-memory count of each row's non-tombstoned entries, so
 * "a tombstoned sibling is not a duplicate" and "#1290: such a row is not even
 * fetched" were two separate tests of two separate mechanisms. Here both are
 * the one column test `live_location_count >= 2`, so they are one test carrying
 * both sets of assertions.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { runDeDuplicateOnce } from './dedupe.ts';

/** Every seeded copy shares one content id — that is what makes them duplicates. */
const MAPLE_ID = 'a'.repeat(32);

/** Quarantine directory name, mirrored from `fs/duplicates.ts`. */
const DUP = '_duplicates';

/**
 * Stage versions every seeded asset starts at. `thumb` and `preview` are
 * non-zero so a re-arm back to zero is visible; `exif` is the control — it is
 * content-keyed, so relocating a copy must not touch it.
 */
const SEEDED_STAGE_VERSIONS = { exif: 1, thumb: 2, preview: 1 } as const;

/** One on-disk location to seed, in `ordinal` order. */
interface LocationSeed {
  /** Directory relative to the library root. */
  dir: string;
  filename?: string;
  missingSince?: string;
  deletedAt?: string;
  /** The stored `keep` flag, deliberately settable without a marker on disk. */
  keep?: boolean;
}

/** One test's database, library root, and the folder row tying them together. */
interface DedupeEnv extends Disposable {
  readonly live: LiveTestDatabase;
  /** Absolute path of the temporary library root. */
  readonly root: string;
  /** Hex id of the `folders` row pointing at {@link root}. */
  readonly libraryId: string;
}

async function createEnv(): Promise<DedupeEnv> {
  const live = await createLiveTestDatabase();
  const root = mkdtempSync(join(tmpdir(), 'maple_dedupe_'));
  const libraryId = insertFolder(live.db, { path: root });
  // `library_id hex → root` is a process-wide cache with no TTL, so the map a
  // previous test built would otherwise point this pass at a directory that has
  // already been removed. Dropped on the way in and on the way out.
  invalidateLibraryRoots();
  const close = (): void => {
    live.close();
    rmSync(root, { recursive: true, force: true });
    invalidateLibraryRoots();
  };
  return { live, root, libraryId, [Symbol.dispose]: close };
}

/** Write real bytes (+ optional sidecar) at `<root>/<dir>/<filename>`. */
function writeCopy(env: DedupeEnv, dir: string, filename: string, withXmp = true): void {
  const abs = dir === '' ? env.root : join(env.root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, filename), `bytes-${dir}-${filename}`);
  if (withXmp) writeFileSync(join(abs, filename.replace(/\.[^.]+$/, '.xmp')), '<xmp/>');
}

/** Drop a `.keep` marker into `<root>/<dir>`, pinning every copy that lives there. */
function writeKeepMarker(env: DedupeEnv, dir: string): void {
  const abs = dir === '' ? env.root : join(env.root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, '.keep'), '');
}

/** Seed one asset with its locations in array order, and its stage bookkeeping. */
function seedAsset(env: DedupeEnv, seeds: readonly LocationSeed[]): string {
  const db = env.live.db;
  const id = insertAsset(db);
  run(db, `UPDATE assets SET maple_id = ? WHERE id = ?`, MAPLE_ID, id);
  seeds.forEach((seed, ordinal) => {
    insertLocation(db, {
      assetId: id,
      libraryId: env.libraryId,
      ordinal,
      path: seed.dir,
      filename: seed.filename ?? 'IMG.dng',
      deletedAt: seed.deletedAt ?? null,
      missingSince: seed.missingSince ?? null,
    });
    if (seed.keep === true) {
      run(
        db,
        `UPDATE asset_locations SET keep = 1 WHERE asset_id = ? AND ordinal = ?`,
        id,
        ordinal,
      );
    }
  });
  for (const [stage, version] of Object.entries(SEEDED_STAGE_VERSIONS)) {
    run(
      db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, ?)`,
      id,
      stage,
      version,
    );
  }
  return id;
}

/** One asset's surviving locations, in array order. */
interface StoredLocation {
  path: string;
  filename: string;
  missing_since: string | null;
  missing_reason: string | null;
}

function locationsOf(env: DedupeEnv, assetId: string): StoredLocation[] {
  return env.live.db
    .query(
      `SELECT path, filename, missing_since, missing_reason
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(assetId) as StoredLocation[];
}

function stageVersion(env: DedupeEnv, assetId: string, stage: string): number | null {
  const row = env.live.db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as { version: number } | null;
  return row?.version ?? null;
}

describe('runDeDuplicateOnce', () => {
  it('collapses to one, relocating the unsorted copy + its xmp into _duplicates', async () => {
    using env = await createEnv();
    writeCopy(env, 'photos/2024', 'IMG.dng');
    writeCopy(env, 'unsorted', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'unsorted' }, { dir: 'photos/2024' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);

    // The clean copy is kept; the unsorted one is moved away.
    expect(existsSync(join(env.root, 'photos/2024', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, 'unsorted', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(env.root, DUP, 'unsorted', 'IMG.dng'))).toBe(true);
    // The sidecar travelled with it.
    expect(existsSync(join(env.root, DUP, 'unsorted', 'IMG.xmp'))).toBe(true);

    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(1);
    expect(locations[0]!.path).toBe('photos/2024');
  });

  it('rule 4 — keeps the LAST copy when no signals distinguish them', async () => {
    using env = await createEnv();
    writeCopy(env, 'a', 'IMG.dng');
    writeCopy(env, 'b', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    await runDeDuplicateOnce({});

    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(1);
    expect(locations[0]!.path).toBe('b'); // last kept
    expect(existsSync(join(env.root, DUP, 'a', 'IMG.dng'))).toBe(true);
  });

  it('re-arms thumb + preview when the cache anchor (the first location) is moved away', async () => {
    using env = await createEnv();
    writeCopy(env, 'a', 'IMG.dng'); // ordinal 0 = current anchor, will be moved
    writeCopy(env, 'b', 'IMG.dng'); // keeper (rule 4)
    // Anchor folder has the maple_id-keyed cache; keeper folder does not.
    // Both the current AVIF thumb and a legacy JPEG left over from before the
    // thumb stage's v3 format migration should be swept.
    mkdirSync(join(env.root, 'a', '.maple', 'thumbs'), { recursive: true });
    writeFileSync(join(env.root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.avif`), 'avif');
    writeFileSync(join(env.root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.jpg`), 'jpg');
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    await runDeDuplicateOnce({});

    // Cache stages reset so the kept copy regenerates at folder b.
    expect(stageVersion(env, id, 'thumb')).toBe(0);
    expect(stageVersion(env, id, 'preview')).toBe(0);
    expect(stageVersion(env, id, 'exif')).toBe(1); // untouched — content-keyed
    // The orphaned cache in the moved-from folder was cleaned — both extensions.
    expect(existsSync(join(env.root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.avif`))).toBe(false);
    expect(existsSync(join(env.root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.jpg`))).toBe(false);
  });

  // --- candidate gate: `live_location_count >= 2` (#1290) ---

  it('a missing_since sibling leaves one live location — not a duplicate set, not even fetched', async () => {
    using env = await createEnv();
    writeCopy(env, 'live', 'IMG.dng');
    const id = seedAsset(env, [
      { dir: 'live' },
      { dir: 'gone', missingSince: '2026-01-01T00:00:00Z' },
    ]);

    const summary = await runDeDuplicateOnce({});

    // Not fetched at all: no scan budget spent, nothing collapsed, row untouched.
    expect(summary.scanned).toBe(0);
    expect(summary.deduped).toBe(0);
    expect(locationsOf(env, id)).toHaveLength(2);
  });

  it('a deleted_at sibling leaves one live location — not fetched either', async () => {
    using env = await createEnv();
    writeCopy(env, 'live', 'IMG.dng');
    seedAsset(env, [{ dir: 'live' }, { dir: 'replaced', deletedAt: '2026-01-01T00:00:00Z' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.scanned).toBe(0);
    expect(summary.deduped).toBe(0);
  });

  it('two live locations ARE fetched and processed', async () => {
    using env = await createEnv();
    writeCopy(env, 'a', 'IMG.dng');
    writeCopy(env, 'b', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.scanned).toBe(1);
    expect(summary.deduped).toBe(1);
    expect(locationsOf(env, id)).toHaveLength(1);
  });

  it('an absent-but-untagged sibling is still fetched — the tag-then-skip drain path', async () => {
    using env = await createEnv();
    // 'keep' exists on disk; 'ghost' does not (absent but NOT yet tagged), so
    // both count as live and the row is a candidate. The pass must fetch it,
    // stat the files, discover 'ghost' is gone, tag it, and return early.
    writeCopy(env, 'keep', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'keep' }, { dir: 'ghost' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.scanned).toBe(1);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    const ghost = locationsOf(env, id).find((e) => e.path === 'ghost');
    expect(ghost!.missing_since).toBeTypeOf('string');
  });

  // --- the move-in-progress race ---
  // discover recorded a new path before its `removed` handler tombstoned the old
  // one, so the asset has two "live" entries but only ONE physical file. Nothing
  // must be relocated — that would leave zero files on disk. Covered for the
  // stale entry being either first or second in the list.

  it('does not move anything when only one copy is actually on disk (stale entry first)', async () => {
    using env = await createEnv();
    writeCopy(env, 'keep', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'ghost' }, { dir: 'keep' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    // The single real file stayed put; nothing was quarantined.
    expect(existsSync(join(env.root, 'keep', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, DUP, 'keep', 'IMG.dng'))).toBe(false);
    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(2); // nothing removed
    // The absent entry was tagged so the reaper can prune it, with structured
    // provenance for the tag (#2171).
    const ghost = locations.find((e) => e.path === 'ghost');
    expect(ghost!.missing_since).toBeTypeOf('string');
    expect(ghost!.missing_reason).toBe('dedupe-absent');
  });

  it('does not move anything when only one copy is actually on disk (stale entry last)', async () => {
    using env = await createEnv();
    // Only 'a' exists; 'b' is the stale entry. Even though rule 4 would prefer
    // 'b' as keeper, it is not on disk so it is never chosen, and 'a' (the only
    // real file) is never moved.
    writeCopy(env, 'a', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    expect(existsSync(join(env.root, 'a', 'IMG.dng'))).toBe(true); // only real copy untouched
    expect(existsSync(join(env.root, DUP, 'a', 'IMG.dng'))).toBe(false);
    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(2);
    const stale = locations.find((e) => e.path === 'b');
    expect(stale!.missing_since).toBeTypeOf('string');
  });

  it('does NOT tag absent entries when the library root is empty (unmounted mountpoint) — #2171', async () => {
    using env = await createEnv();
    // Both copies stat ENOENT because the ROOT is an empty dir (unmounted
    // mount look-alike) — that is evidence about the root, not the files.
    // The asset must be skipped untouched, not mass-tagged missing.
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.skippedOffline).toBe(1);
    for (const location of locationsOf(env, id)) {
      expect(location.missing_since).toBeNull();
    }
  });

  it('dry-run reports the work but mutates nothing', async () => {
    using env = await createEnv();
    writeCopy(env, 'a', 'IMG.dng');
    writeCopy(env, 'b', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'a' }, { dir: 'b' }]);

    const summary = await runDeDuplicateOnce({ dryRun: true });

    expect(summary.dryRun).toBe(1);
    expect(summary.movedFiles).toBe(0);
    expect(existsSync(join(env.root, 'a', 'IMG.dng'))).toBe(true); // not moved
    expect(locationsOf(env, id)).toHaveLength(2); // not removed
  });

  // --- `.keep` marker: pin copies in a folder against collapse ---

  it('keeps the copy in a `.keep` folder and moves the un-pinned one', async () => {
    using env = await createEnv();
    // 'photos/2024' would normally be the keeper (clean path), but the operator
    // pinned the 'extra' copy with a `.keep` marker — so 'extra' must survive
    // and the un-pinned 'photos/2024' copy is the one moved away.
    writeCopy(env, 'photos/2024', 'IMG.dng');
    writeCopy(env, 'extra', 'IMG.dng');
    writeKeepMarker(env, 'extra');
    const id = seedAsset(env, [{ dir: 'photos/2024' }, { dir: 'extra' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    expect(existsSync(join(env.root, 'extra', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, 'photos/2024', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(env.root, DUP, 'photos/2024', 'IMG.dng'))).toBe(true);

    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(1);
    expect(locations[0]!.path).toBe('extra');
  });

  it('keeps EVERY pinned copy when more than one folder is marked `.keep`', async () => {
    using env = await createEnv();
    // Two pinned folders + one un-pinned copy: both pinned copies survive, only
    // the un-pinned one is moved.
    for (const dir of ['keepA', 'keepB', 'loose']) writeCopy(env, dir, 'IMG.dng');
    writeKeepMarker(env, 'keepA');
    writeKeepMarker(env, 'keepB');
    const id = seedAsset(env, [{ dir: 'keepA' }, { dir: 'keepB' }, { dir: 'loose' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    expect(existsSync(join(env.root, 'keepA', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, 'keepB', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, 'loose', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(env.root, DUP, 'loose', 'IMG.dng'))).toBe(true);

    expect(locationsOf(env, id).map((e) => e.path)).toEqual(['keepA', 'keepB']);
  });

  it('leaves the asset untouched when every on-disk copy is pinned `.keep`', async () => {
    using env = await createEnv();
    writeCopy(env, 'keepA', 'IMG.dng');
    writeCopy(env, 'keepB', 'IMG.dng');
    writeKeepMarker(env, 'keepA');
    writeKeepMarker(env, 'keepB');
    const id = seedAsset(env, [{ dir: 'keepA' }, { dir: 'keepB' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(0);
    expect(summary.movedFiles).toBe(0);
    expect(summary.skippedAllKept).toBe(1);
    // Both copies remain on disk and in the row.
    expect(existsSync(join(env.root, 'keepA', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(env.root, 'keepB', 'IMG.dng'))).toBe(true);
    expect(locationsOf(env, id)).toHaveLength(2);
  });

  it('re-confirms `.keep` on disk — a stale stored keep flag does not block collapse', async () => {
    using env = await createEnv();
    // The stored flag claims 'a' is pinned, but there is no `.keep` file on disk
    // (the marker was removed after indexing). The worker trusts disk and
    // collapses normally — keeping the last copy per rule 4.
    writeCopy(env, 'a', 'IMG.dng');
    writeCopy(env, 'b', 'IMG.dng');
    const id = seedAsset(env, [{ dir: 'a', keep: true }, { dir: 'b' }]);

    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    const locations = locationsOf(env, id);
    expect(locations).toHaveLength(1);
    expect(locations[0]!.path).toBe('b'); // rule 4 last-kept, stored flag ignored
  });
});
