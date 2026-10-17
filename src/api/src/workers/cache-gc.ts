/**
 * Cache GC — sweep orphaned `.maple/{thumbs,previews}/*.{jpg,avif,json}` files.
 *
 * Walks a library root looking for `.maple/thumbs` and `.maple/previews`
 * directories. BOTH tiers are now path-keyed off the source filename (see
 * `resolveThumbPathForAsset`'s doc in `fs/xmp.ts` for why thumbs went back to
 * that from content-addressing), so both orphan checks are library-scoped:
 *
 *   - `thumbs` is `<filename>.avif` (#4793): a file is live iff its stem is
 *     a live filename in THIS exact directory. This is also the name the pano
 *     stitcher pre-seeds (`maple-pano/src/stitch/io.rs::write_display_sidecars`,
 *     #1365) and every client reads.
 *   - `previews` is path-keyed (`<filename>.<suffix>`, any of `.avif`/`.jpg`/
 *     `.json`): a file is orphaned when its filename isn't a live location
 *     in THIS library at THIS exact directory. Since previews no longer
 *     survive a rename/move by design, this sweep is now mostly a BACKSTOP —
 *     the primary cleanup happens synchronously wherever a `fileinfo` entry
 *     is removed (`cleanPreviewsCacheForLocation`, called from
 *     `missing-reaper.ts`/`dedupe.ts`) — for whatever that missed (a crash
 *     mid-cleanup, files present before this backstop ever ran).
 *
 * The 32-hex `<maple_id>.avif` thumbs written while the thumb stage was
 * content-addressed are a RETIRED scheme and always orphaned. They must be,
 * or they would never be reclaimed: the assets still carry those `maple_id`s
 * (it remains the thumb ETag), so a liveness check against the DB would keep
 * every one of them forever — one stale file per asset. The thumb stage's
 * `targetVersion` bump re-renders each asset at the path-keyed name, and this
 * sweep reclaims what the old name left behind.
 *
 * Retired names (#4793) are migrated by RENAME, never regeneration, before
 * orphans are judged:
 *   - previews were briefly `<filename>.v<N>.<kind>`: the highest-N file
 *     becomes `<filename>.<kind>` when that name is missing, and every other
 *     versioned sibling is deleted.
 *   - thumbs were `<sha256_prefix16(filename)>[.v<N>].avif`: each live
 *     filename in the directory is hashed, its newest hashed AVIF becomes
 *     `<filename>.avif` when that name is missing, and every other hashed file
 *     — including one whose hash matches no live filename — is deleted.
 * A renamed file then goes through the normal orphan check under its new name.
 *
 * No migration sentinel:
 *   The set of orphans changes continuously (a re-render at a new size, a
 *   rename, a hard-delete each create one). A one-shot sentinel-gated sweep
 *   would miss every orphan produced after the sentinel was recorded.
 *   Instead, the supervisor calls `sweepOrphanedCaches` once at boot per
 *   registered library as a fire-and-forget background task. Bounded work:
 *   each sweep is O(files-in-library).
 */
import type { Dirent } from 'node:fs';
// Mirror-aware drop-in: an orphan reclaimed here is reclaimed on the library's
// backup root too, so replicating the `.maple/` cache (#926) can't turn this
// sweep into a one-way accumulation of dead files on the mirror. Reads
// (readdir/stat) pass straight through.
import * as fs from '../fs/mirrored.ts';
import * as path from 'node:path';
import { liveLocationsByDirectory } from '../db/repos/assets.sweeps.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { sourceFilenameForPreviewCacheName } from '../fs/preview-cache-cleanup.ts';
import { parseVersionedDerivativeName } from '../fs/legacy-derivative.ts';
import { sha256Prefix16 } from '../fs/xmp.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('cache-gc');

export interface SweepResult {
  scanned: number;
  deleted: number;
  skipped_recent: number;
}

/**
 * Files written within this window are assumed mid-write or just-written by a
 * concurrent stage. Skip them this pass — the next boot's sweep will catch
 * them if they're genuinely orphaned. Cheapest defense against the TOCTOU
 * race where the live set is snapshotted before a stage finishes writing a
 * fresh thumb.
 */
const RECENT_THRESHOLD_MS = 60 * 1000;

/**
 * Abort the sweep after this many consecutive same-errno unlink failures.
 * EACCES / EROFS / EBUSY signal an operator-level config problem (mount
 * read-only, perms wrong, busy by another process) — no point continuing
 * to retry across thousands of files for noise we can't fix from here.
 */
const FAIL_THRESHOLD = 3;

/** A retired hashed thumb: `<sha256_prefix16(filename)>[.v<N>].<avif|jpg>`. */
const HASHED_THUMB_RE = /^([0-9a-f]{16})(?:\.v([1-9][0-9]*))?\.(avif|jpg)$/;

/** A retired content-addressed `<maple_id>` thumb (module doc). */
const MAPLE_ID_THUMB_RE = /^[0-9a-f]{32}\.(?:avif|jpg)$/;

/** Resolve `libraryRoot`'s registered library id (hex), or `null` if it isn't a
 * registered library root (or the lookup fails). `null` makes the previews
 * sweep scan/count as normal but skip every delete decision (see
 * `sweepPreviewsDir`) rather than treat an empty known-live set as "nothing
 * is live" — a transient failure here must never cause a mass-delete of
 * live previews.
 *
 * Hex rather than an `ObjectId`: `loadLibraryRoots()` is keyed by hex and the
 * live-set query takes hex, so wrapping and unwrapping in between would buy
 * nothing but a round trip. */
async function resolveLibraryId(libraryRoot: string): Promise<string | null> {
  try {
    const libs = await loadLibraryRoots();
    for (const [idHex, root] of libs) {
      if (root === libraryRoot) return idHex;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Mutable counters threaded through one sweep pass via `SweepContext`,
 * pulled out of `sweepOrphanedCaches` so every helper below is a top-level
 * function (explicit params, not closure capture) rather than a nest of
 * inner functions — keeps each one independently readable and measurable. */
interface SweepCounters {
  scanned: number;
  deleted: number;
  skippedRecent: number;
  recentFailErrno: string | null;
  recentFailCount: number;
  renamed: number;
}

/** Per-pass, read-mostly context threaded through `walk`/`sweepThumbsDir`/
 * `sweepPreviewsDir`/`sweepCacheDir`/`unlinkSafe`. `counters` is the only
 * mutable part (mutated in place, not reassigned). */
interface SweepContext {
  counters: SweepCounters;
  now: number;
  /** relDir -> live filenames at that exact directory. Despite the name,
   * consumed by BOTH `sweepPreviewsDir` and `sweepThumbsDir` — both tiers are
   * path-keyed now, so this is the live set for each (see `isOrphanThumb`);
   * not renamed to avoid unrelated churn across every call site. */
  knownPreviewFilenames: ReadonlyMap<string, ReadonlySet<string>>;
  libraryId: string | null;
}

/**
 * LEGACY state cleanup. Suffix of the thumb freshness sidecar
 * (`<key>.avif.meta`) the pre-#2258 `.meta` protocol used to write
 * (`thumbs/thumb-meta.ts`, since deleted). Nothing writes these any more —
 * `/api/fs/thumb`'s cache-hit path is a single `readFile`, no sidecar, no
 * per-read freshness check — but #2252 shipped and ran in production before
 * #2258 removed it, so every install that has been running since has one
 * `.meta` file per thumbnail already on disk. This sweep drains that
 * pre-existing state; it is not part of any current write path. Appended to
 * the WHOLE artefact filename, which is why it can't live in `THUMB_EXTS` —
 * see `reapStrandedSidecars`.
 */
const SIDECAR_SUFFIX = '.meta';

const THUMB_EXTS = new Set(['.jpg', '.avif']);
const PREVIEW_EXTS = new Set(['.jpg', '.avif', '.webp', '.png', '.json']);

/** A thumb is live only as `<liveFilename>.avif` in this exact directory. That
 * live set is library-scoped (built from `knownPreviewFilenames`), so it needs
 * the same `libraryId === null` guard as `isOrphanPreview`: no resolvable
 * library id → no known-live set was (or safely could be) built for this pass,
 * so never delete on that branch (jules review, PR #2008 round 2).
 *
 * A 32-hex `<maple_id>` name is the retired content-addressed naming and is
 * unconditionally orphaned — deliberately WITHOUT the `libraryId` guard, since
 * that scheme is dead regardless of what the DB says, so a transient lookup
 * failure is not a reason to keep the file. See the module doc for why a
 * liveness check would leak one file per asset instead. */
function isOrphanThumb(
  libraryId: string | null,
  liveNames: ReadonlySet<string>,
  name: string,
): boolean {
  if (MAPLE_ID_THUMB_RE.test(name)) return true;
  if (libraryId === null) return false;
  return !(name.endsWith('.avif') && liveNames.has(name.slice(0, -'.avif'.length)));
}

/** A preview is orphaned unless its path-keyed `<filename>.<suffix>` (via
 * `sourceFilenameForPreviewCacheName`) names a live file in this exact
 * directory. No resolvable library id → no known-live set was (or safely could
 * be) built for this pass, so never delete — a transient failure to resolve
 * the library must not mass-delete live previews (see `resolveLibraryId`). */
function isOrphanPreview(
  libraryId: string | null,
  liveNames: ReadonlySet<string>,
  name: string,
): boolean {
  if (libraryId === null) return false;
  const source = sourceFilenameForPreviewCacheName(name);
  if (source !== null) return !liveNames.has(source);
  return true;
}

async function unlinkSafe(ctx: SweepContext, p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
    ctx.counters.recentFailCount = 0;
    ctx.counters.recentFailErrno = null;
    return true;
  } catch (err) {
    const errno = (err as { code?: string } | null)?.code ?? 'UNKNOWN';
    if (errno === 'ENOENT') {
      // Race: file vanished between readdir/stat and unlink (another
      // process, or a stage cleaning up its own artefact). The desired
      // state — file gone — is achieved, so don't count this toward the
      // failure threshold and don't log noise. Reset the streak just like
      // the success path so a real EACCES burst stays isolated.
      ctx.counters.recentFailCount = 0;
      ctx.counters.recentFailErrno = null;
      return false;
    }
    if (errno === ctx.counters.recentFailErrno) {
      ctx.counters.recentFailCount += 1;
    } else {
      ctx.counters.recentFailErrno = errno;
      ctx.counters.recentFailCount = 1;
    }
    log.warn({ p, errno, err: err instanceof Error ? err.message : err }, 'unlink failed');
    if (ctx.counters.recentFailCount >= FAIL_THRESHOLD) {
      log.error(
        { errno, count: ctx.counters.recentFailCount },
        'cache-gc: too many unlink failures — aborting sweep',
      );
      throw new Error(
        `cache-gc aborted: ${ctx.counters.recentFailCount} consecutive ${errno} failures`,
        { cause: err },
      );
    }
    return false;
  }
}

/** Shared readdir → filter-by-extension → TOCTOU-recency-guard → per-entry
 * orphan decision. Thumbs and previews differ only in which extensions they
 * accept and how they judge one entry orphaned — everything else about
 * walking a cache directory is identical between them. */
/**
 * LEGACY state cleanup: reap `.meta` sidecars whose artefact is gone.
 *
 * Nothing writes `.meta` any more (see `SIDECAR_SUFFIX`'s doc comment) —
 * this exists purely to drain what the pre-#2258 `.meta` protocol left
 * behind on every install that ran #2252. The main loop below deletes a
 * sidecar alongside the thumb it describes, which covers every orphan this
 * GC itself creates. It cannot cover a sidecar STRANDED by something else —
 * a thumb deleted out of band, or an interrupted external cleanup — because
 * `.meta` is deliberately absent from `allowedExts` and so is never scanned
 * as an entry (jules review, PR #2252). Left alone those leak forever, so
 * sweep them here against the directory listing already in hand: a sidecar
 * is stranded iff no sibling of the same name minus `.meta` exists.
 *
 * Reuses the recency window — a sidecar written moments ago belongs to a
 * thumb a stage is mid-publish on. Uncounted, like the attached case: a
 * sidecar is never independently `scanned`, so counting its deletion would
 * not reconcile.
 */
async function reapStrandedSidecars(
  ctx: SweepContext,
  cacheDir: string,
  entries: readonly Dirent[],
): Promise<void> {
  const present = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const entry of entries) {
    const suffix = entry.name.endsWith('.v')
      ? '.v'
      : entry.name.endsWith(SIDECAR_SUFFIX)
        ? SIDECAR_SUFFIX
        : null;
    if (!entry.isFile() || suffix === null) continue;
    if (suffix === SIDECAR_SUFFIX && present.has(entry.name.slice(0, -suffix.length))) continue;
    const fullPath = path.join(cacheDir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && ctx.now - stat.mtimeMs < RECENT_THRESHOLD_MS) continue;
    await unlinkSafe(ctx, fullPath);
  }
}

/** Delete a cache file judged dead, plus its legacy attachments, unless it was
 * written inside the recency window. */
async function deleteUnlessRecent(ctx: SweepContext, fullPath: string): Promise<void> {
  // TOCTOU defense: the known/live set was snapshotted before this walk
  // began. A stage may have written this file in the meantime. If the
  // file's mtime is within the recency window, defer to the next boot's
  // sweep.
  const stat = await fs.stat(fullPath).catch(() => null);
  if (stat && ctx.now - stat.mtimeMs < RECENT_THRESHOLD_MS) {
    ctx.counters.skippedRecent += 1;
    return;
  }
  if (!(await unlinkSafe(ctx, fullPath))) return;
  ctx.counters.deleted += 1;
  // LEGACY state cleanup: reap the `.meta` freshness sidecar alongside
  // the artefact it describes, if one exists (see `SIDECAR_SUFFIX`'s
  // doc comment — nothing writes these any more, but #2252 shipped and
  // every install running since has one per thumbnail). It CANNOT be
  // swept as an entry in its own right: `path.extname('<key>.avif.meta')`
  // is `.meta`, leaving the stem `<key>.avif`, which matches no
  // live-key shape — so a `.meta` in `allowedExts` would make
  // `isOrphanThumb` condemn sidecars of perfectly live thumbs (jules
  // review, PR #2252). Deliberately NOT counted in `deleted`: it was
  // never `scanned`, and an attachment is not an independent orphan.
  // `unlinkSafe` treats the ENOENT this hits for every preview (which
  // never had a sidecar) as an uncounted no-op.
  await unlinkSafe(ctx, `${fullPath}.meta`);
  await unlinkSafe(ctx, `${fullPath}.v`);
}

async function renameQuiet(ctx: SweepContext, cacheDir: string, from: string, to: string) {
  return fs.rename(path.join(cacheDir, from), path.join(cacheDir, to)).then(
    () => {
      ctx.counters.renamed += 1;
      return true;
    },
    (err: unknown) => {
      log.warn(
        { cacheDir, from, to, err: err instanceof Error ? err.message : err },
        'rename of legacy derivative failed',
      );
      return false;
    },
  );
}

/** Group a directory's `<name>.v<N>.<kind>` files by their unversioned name,
 * highest N first. */
function versionedSiblings(names: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, { name: string; version: number }[]>();
  for (const name of names) {
    const parsed = parseVersionedDerivativeName(name);
    if (!parsed) continue;
    groups.set(parsed.unversioned, [
      ...(groups.get(parsed.unversioned) ?? []),
      { name, version: parsed.version },
    ]);
  }
  return new Map(
    [...groups].map(([unversioned, files]) => [
      unversioned,
      files.toSorted((a, b) => b.version - a.version).map((file) => file.name),
    ]),
  );
}

/**
 * Migrate the retired pipeline-versioned names in one cache directory (module
 * doc) and return the unversioned file names left for the orphan check. A
 * versioned file whose rename or delete didn't happen is never handed to the
 * orphan check, so a failed migration can't turn into a deletion of the only
 * copy of a derivative.
 */
async function migrateVersionedNames(
  ctx: SweepContext,
  cacheDir: string,
  names: readonly string[],
): Promise<string[]> {
  const present = new Set(names.filter((name) => parseVersionedDerivativeName(name) === null));
  for (const [unversioned, [highest, ...older]] of versionedSiblings(names)) {
    const alreadyPresent = present.has(unversioned);
    const adopted = !alreadyPresent && (await renameQuiet(ctx, cacheDir, highest, unversioned));
    if (adopted) present.add(unversioned);
    const stale = alreadyPresent ? [highest, ...older] : adopted ? older : [];
    ctx.counters.scanned += stale.length;
    for (const name of stale) await deleteUnlessRecent(ctx, path.join(cacheDir, name));
  }
  return [...present];
}

/**
 * Migrate the retired hashed thumb names in one directory (module doc) and
 * return the file names left for the orphan check. Without a resolvable
 * library there is no live set to map hashes back to filenames, so nothing is
 * renamed or deleted. A hashed file whose rename failed is never handed on.
 */
async function migrateHashedThumbs(
  ctx: SweepContext,
  cacheDir: string,
  names: readonly string[],
  liveNames: ReadonlySet<string>,
): Promise<string[]> {
  if (ctx.libraryId === null) return [...names];
  const present = new Set(names.filter((name) => !HASHED_THUMB_RE.test(name)));
  const groups = new Map<string, { name: string; version: number; avif: boolean }[]>();
  for (const name of names) {
    const match = HASHED_THUMB_RE.exec(name);
    if (!match) continue;
    const file = { name, version: Number(match[2] ?? 0), avif: match[3] === 'avif' };
    groups.set(match[1], [...(groups.get(match[1]) ?? []), file]);
  }
  const liveByHash = new Map([...liveNames].map((live) => [sha256Prefix16(live), live]));
  for (const [hash, files] of groups) {
    const live = liveByHash.get(hash);
    const target = live === undefined ? null : `${live}.avif`;
    const newest = files.filter((file) => file.avif).toSorted((a, b) => b.version - a.version)[0];
    const attempt = target !== null && newest !== undefined && !present.has(target);
    const adopted = attempt && (await renameQuiet(ctx, cacheDir, newest.name, target));
    if (adopted) present.add(target);
    const stale = files.filter((file) => file !== newest || !attempt);
    ctx.counters.scanned += stale.length;
    for (const file of stale) await deleteUnlessRecent(ctx, path.join(cacheDir, file.name));
  }
  return [...present];
}

async function sweepCacheDir(
  ctx: SweepContext,
  cacheDir: string,
  allowedExts: ReadonlySet<string>,
  migrate: (names: readonly string[]) => Promise<string[]>,
  isOrphan: (entryName: string) => boolean,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(cacheDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return; // ENOENT — fine, no cache here.
  }
  const cacheFiles = entries
    .filter((entry) => entry.isFile() && allowedExts.has(path.extname(entry.name)))
    .map((entry) => entry.name);
  for (const name of await migrate(cacheFiles)) {
    ctx.counters.scanned += 1;
    // Check the in-memory orphan verdict BEFORE touching the filesystem
    // again — a known/live file (the common case) never needs a stat call
    // at all, saving a syscall per file in every directory this sweeps
    // (jules review, PR #2006).
    if (!isOrphan(name)) continue;
    await deleteUnlessRecent(ctx, path.join(cacheDir, name));
  }

  await reapStrandedSidecars(ctx, cacheDir, entries);
}

async function sweepThumbsDir(ctx: SweepContext, cacheDir: string, relDir: string): Promise<void> {
  // `knownPreviewFilenames` is really just "live filenames per directory" —
  // the live set for thumbs too, not previews specifically.
  const liveNames = ctx.knownPreviewFilenames.get(relDir) ?? new Set<string>();
  await sweepCacheDir(
    ctx,
    cacheDir,
    THUMB_EXTS,
    (names) => migrateHashedThumbs(ctx, cacheDir, names, liveNames),
    (name) => isOrphanThumb(ctx.libraryId, liveNames, name),
  );
}

/** Previews orphan sweep — mostly a backstop now (see module doc): the
 * primary cleanup is synchronous, at the point a `fileinfo` entry is
 * removed. */
async function sweepPreviewsDir(
  ctx: SweepContext,
  cacheDir: string,
  relDir: string,
): Promise<void> {
  const liveNames = ctx.knownPreviewFilenames.get(relDir) ?? new Set<string>();
  await sweepCacheDir(
    ctx,
    cacheDir,
    PREVIEW_EXTS,
    (names) => migrateVersionedNames(ctx, cacheDir, names),
    (name) => isOrphanPreview(ctx.libraryId, liveNames, name),
  );
}

async function walk(ctx: SweepContext, dir: string, relDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    // Skip symlinks defensively — with `withFileTypes: true`, a symlink
    // entry has `isSymbolicLink() === true` and `isDirectory() === false`
    // (the dirent reflects lstat, not stat). Without this guard, a future
    // change that resolves the target before classification could let a
    // self-referential or upward-pointing dir symlink loop the walk forever.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.maple') {
        await sweepThumbsDir(ctx, path.join(full, 'thumbs'), relDir);
        await sweepPreviewsDir(ctx, path.join(full, 'previews'), relDir);
      } else if (!entry.name.startsWith('.')) {
        const childRelDir = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        await walk(ctx, full, childRelDir);
      }
    }
  }
}

export async function sweepOrphanedCaches(libraryRoot: string): Promise<SweepResult> {
  const libraryId = await resolveLibraryId(libraryRoot);
  // The live set is `directory → live filenames` for this library alone —
  // derivatives are path-keyed per-location, not DB-wide unique like maple_id,
  // so a library-wide answer would let one library's names keep another's
  // orphans alive. `liveLocationsByDirectory` answers it in one statement
  // (#3787); the Mongo version had to stream every matching asset document and
  // re-filter its `fileinfo` array here, because `$elemMatch` returns documents
  // and cannot project the entries that matched.
  const knownPreviewFilenames =
    libraryId === null ? new Map<string, Set<string>>() : await liveLocationsByDirectory(libraryId);

  const ctx: SweepContext = {
    counters: {
      scanned: 0,
      deleted: 0,
      skippedRecent: 0,
      recentFailErrno: null,
      recentFailCount: 0,
      renamed: 0,
    },
    now: Date.now(),
    knownPreviewFilenames,
    libraryId,
  };

  try {
    await walk(ctx, libraryRoot, '');
  } catch (err) {
    // unlinkSafe threw past FAIL_THRESHOLD — return the partial result so
    // the caller can log the operator-actionable error without losing the
    // counts collected up to the abort point.
    log.error(
      { err: err instanceof Error ? err.message : err, ...ctx.counters },
      'cache-gc sweep aborted with partial result',
    );
  }
  if (ctx.counters.renamed > 0) {
    log.info(
      { libraryRoot, renamed: ctx.counters.renamed },
      'cache-gc renamed versioned derivatives',
    );
  }
  return {
    scanned: ctx.counters.scanned,
    deleted: ctx.counters.deleted,
    skipped_recent: ctx.counters.skippedRecent,
  };
}
