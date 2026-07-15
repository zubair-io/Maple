/**
 * Cache GC — sweep orphaned `.maple/{thumbs,previews}/*.{jpg,avif,json,v}` files.
 *
 * Walks a library root looking for `.maple/thumbs` and `.maple/previews`
 * directories. Thumbs and previews now use TWO DIFFERENT orphan-detection
 * schemes, since previews dropped content-addressing (see
 * `cachePathForAsset`'s doc in `fs/xmp.ts`):
 *
 *   - `thumbs` stays `maple_id`-keyed (`<maple_id>.avif`, `.jpg` for legacy
 *     pre-v3 orphans): a file is orphaned when its `maple_id` isn't in the
 *     `known` set built once from the whole `assets` collection (a
 *     `maple_id` is unique DB-wide, so this needs no per-library scoping).
 *   - `previews` is path-keyed (`<filename>.<suffix>`, any of `.avif`/`.jpg`/
 *     `.json`): a file is orphaned when its filename isn't a live location
 *     in THIS library at THIS exact directory. Since previews no longer
 *     survive a rename/move by design, this sweep is now mostly a BACKSTOP —
 *     the primary cleanup happens synchronously wherever a `fileinfo` entry
 *     is removed (`cleanPreviewsCacheForLocation`, called from
 *     `missing-reaper.ts`/`dedupe.ts`) — for whatever that missed (a crash
 *     mid-cleanup, files present before this backstop ever ran).
 *
 * Both sweeps ALSO recognize a third scheme: `sha256_prefix16(basename)`-keyed
 * pre-seed thumbs/previews written by the pano stitcher
 * (`maple-pano/src/stitch/io.rs::write_display_sidecars`, #1365) immediately
 * after stitching, before the pano is indexed and gets a `maple_id`. Apple's
 * `MapleSidecarPaths` mirrors this exact scheme on the read side, so it is a
 * real, live, cross-platform-frozen key — NOT a "legacy, always-orphaned"
 * shape the way the old pre-content-addressing `sha256_prefix16` thumb keys
 * are (those really are always orphans post-migration; this one, keyed the
 * SAME way, is not). Recognized iff SOME live filename in this exact
 * directory hashes to the file's stem — see `isOrphanThumb`/`isOrphanPreview`.
 *
 * The previews sweep additionally recognizes a FOURTH scheme, previews-only:
 * `sha256_prefix16(basename)_1600.edited.jpg` — Apple's LOCAL-ONLY edited/
 * developed-render preview (`MapleSidecarPaths.editedPreviewURL`, #2009).
 * Same "verify against a live filename in this directory" carve-out as the
 * pano pre-seed scheme above, NOT an unconditional keep: this file is Apple's
 * own render, deliberately never written to the shared `sha256_prefix16(...)
 * _1600.jpg` camera-original contract the describe/OCR (VLM) pipeline reads
 * (an earlier design draft that did so was a confirmed correctness-and-
 * privacy bug, not just a caching one). cache-gc only judges liveness here;
 * Apple's own client handles sidecar-state staleness for this file
 * (`ThumbnailLoader.freshEditedPreviewData`/`removeEditedPreview`) since a
 * DB-side sweep has no visibility into XMP sidecar content.
 *
 * Two more previews-only files ride the SAME hash key with a `.v` extension
 * instead of `.jpg`: `<hash>_1600.v` (`MapleSidecarPaths.previewVersionURL`,
 * the canonical tier's render-semantics marker, #1976) and
 * `<hash>_1600.edited.v` (`editedPreviewMarkerURL`, this file's sidecar-state
 * marker). `PREVIEW_EXTS` includes `.v` so these are swept (not silently
 * ignored forever) and recognized live the same "hash matches a live
 * filename" way as their `.jpg` siblings (Jules review, PR #2013).
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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { sourceFilenameForPreviewCacheName } from '../fs/preview-cache-cleanup.ts';
import { sha256Prefix16 } from '../fs/xmp.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('cache-gc');

export interface SweepResult {
  scanned: number;
  deleted: number;
  skipped_recent: number;
}

/** Minimal projected shape of one `fileinfo` entry, for the previews
 * known-live-set query below. */
interface FileInfoLocation {
  library_id: ObjectId;
  path: string;
  filename: string;
  deleted_at?: unknown;
  missing_since?: unknown;
}

/**
 * Files written within this window are assumed mid-write or just-written by a
 * concurrent stage. Skip them this pass — the next boot's sweep will catch
 * them if they're genuinely orphaned. Cheapest defense against the TOCTOU
 * race where `known` is snapshotted before a stage finishes writing a fresh
 * `<maple_id>.avif`.
 */
const RECENT_THRESHOLD_MS = 60 * 1000;

/**
 * Abort the sweep after this many consecutive same-errno unlink failures.
 * EACCES / EROFS / EBUSY signal an operator-level config problem (mount
 * read-only, perms wrong, busy by another process) — no point continuing
 * to retry across thousands of files for noise we can't fix from here.
 */
const FAIL_THRESHOLD = 3;

/**
 * Matches `<maple_id>` (32 lowercase hex), thumbs-only now that previews
 * dropped content-addressing (see this file's module doc). The legacy
 * `sha256_prefix16` cache key is 16 hex chars and does NOT match — it falls
 * through to the pano-pre-seed check (`LEGACY_SHA256_PREFIX16_RE`) below.
 * The trailing optional suffix group is dead for thumbs' actual naming
 * (`<maple_id>.avif`, no suffix) but kept harmless/permissive rather than
 * tightened without a concrete need to.
 */
const MAPLE_ID_RE = /^[0-9a-f]{32}(?:_[a-z0-9_]+)?$/;

/** Matches a `sha256_prefix16(basename)` stem (16 lowercase hex) — the
 * pano-injection pre-seed thumb key (module doc). */
const LEGACY_SHA256_PREFIX16_RE = /^[0-9a-f]{16}$/;

/** Matches a `sha256_prefix16(basename)_1600.jpg` filename — the
 * pano-injection pre-seed preview (module doc). Captures the 16-hex key. */
const LEGACY_PANO_PREVIEW_RE = /^([0-9a-f]{16})_1600\.jpg$/;

/** Matches a `sha256_prefix16(basename)_1600.edited.jpg` filename — Apple's
 * local-only edited/developed-render preview (module doc, #2009). Captures
 * the 16-hex key. Distinct suffix from `LEGACY_PANO_PREVIEW_RE` so the two
 * schemes never collide even though both key off the same hash. */
const EDITED_PREVIEW_RE = /^([0-9a-f]{16})_1600\.edited\.jpg$/;

/** Matches a `sha256_prefix16(basename)_1600.v` filename — the canonical
 * hash-keyed preview tier's render-semantics marker (`previewVersionURL`,
 * #1976, module doc). Captures the 16-hex key. */
const PREVIEW_VERSION_MARKER_RE = /^([0-9a-f]{16})_1600\.v$/;

/** Matches a `sha256_prefix16(basename)_1600.edited.v` filename — the
 * edited-preview tier's sidecar-state marker (`editedPreviewMarkerURL`,
 * #2009, module doc). Captures the 16-hex key. */
const EDITED_PREVIEW_MARKER_RE = /^([0-9a-f]{16})_1600\.edited\.v$/;

/** Resolve `libraryRoot`'s registered `_id`, or `null` if it isn't a
 * registered library root (or the lookup fails). `null` makes the previews
 * sweep scan/count as normal but skip every delete decision (see
 * `sweepPreviewsDir`) rather than treat an empty known-live set as "nothing
 * is live" — a transient failure here must never cause a mass-delete of
 * live previews. */
async function resolveLibraryId(libraryRoot: string): Promise<ObjectId | null> {
  try {
    const libs = await loadLibraryRoots();
    for (const [idHex, root] of libs) {
      if (root === libraryRoot) return new ObjectId(idHex);
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
}

/** Per-pass, read-mostly context threaded through `walk`/`sweepThumbsDir`/
 * `sweepPreviewsDir`/`sweepCacheDir`/`unlinkSafe`. `counters` is the only
 * mutable part (mutated in place, not reassigned). */
interface SweepContext {
  counters: SweepCounters;
  now: number;
  knownMapleIds: ReadonlySet<string>;
  /** relDir -> live filenames at that exact directory. Despite the name,
   * consumed by BOTH `sweepPreviewsDir` (primary use) and `sweepThumbsDir`
   * (the pano-pre-seed legacy-scheme check only — see `isOrphanThumb`'s
   * doc); not renamed to avoid unrelated churn across every call site. */
  knownPreviewFilenames: ReadonlyMap<string, ReadonlySet<string>>;
  libraryId: ObjectId | null;
}

const THUMB_EXTS = new Set(['.jpg', '.avif']);
// `.v` covers both hash-keyed marker siblings — `<hash>_1600.v`
// (`previewVersionURL`) and `<hash>_1600.edited.v` (`editedPreviewMarkerURL`,
// #2009) — see this file's module doc.
const PREVIEW_EXTS = new Set(['.jpg', '.avif', '.json', '.v']);

/** Lazily builds (and memoizes) the set of `sha256Prefix16(liveName)`
 * hashes for one directory's live filenames — used by the pano pre-seed
 * legacy-scheme checks below. A directory is swept file-by-file, and most
 * directories contain zero legacy-scheme candidates, so hashing every live
 * filename is deferred until the first candidate actually needs it, then
 * reused (O(1) `.has`) for every subsequent candidate in the same directory
 * — each live filename is hashed at most once per sweep pass, not once per
 * candidate file (jules + Copilot review, PR #2008: the prior version
 * rehashed every live filename per legacy candidate, O(legacyFiles ×
 * liveFiles)). */
function lazyHashedNames(liveNames: ReadonlySet<string>): () => ReadonlySet<string> {
  let hashed: ReadonlySet<string> | null = null;
  return () => {
    if (hashed === null) {
      hashed = new Set([...liveNames].map((name) => sha256Prefix16(name)));
    }
    return hashed;
  };
}

/** A thumb is orphaned unless it matches ONE of two live schemes: the
 * modern, indexed-asset `<maple_id>.avif` (library-independent — checked
 * against the DB-wide `knownMapleIds` set regardless of whether this
 * library root resolves), or the pano-injection pre-seed
 * `<sha256_prefix16(liveFilename)>.avif` (module doc) — legitimate iff SOME
 * live filename in this exact directory hashes to the file's stem. Unlike
 * `knownMapleIds`, the legacy scheme's live set is library-scoped
 * (`hashedLiveNames`, built from `knownPreviewFilenames`), so it needs the
 * same `libraryId === null` guard as `isOrphanPreview`: no resolvable
 * library id → no known-live set was (or safely could be) built for this
 * pass, so never delete on that branch (jules review, PR #2008 round 2). */
function isOrphanThumb(
  knownMapleIds: ReadonlySet<string>,
  libraryId: ObjectId | null,
  hashedLiveNames: () => ReadonlySet<string>,
  name: string,
): boolean {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  if (MAPLE_ID_RE.test(stem)) {
    return !knownMapleIds.has(stem.slice(0, 32));
  }
  if (LEGACY_SHA256_PREFIX16_RE.test(stem)) {
    if (libraryId === null) return false;
    return !hashedLiveNames().has(stem);
  }
  return true; // unrecognized shape, or a recognized-but-dead pre-seed key
}

/** Every hash-keyed previews scheme besides the modern path-keyed one:
 * the pano pre-seed preview, Apple's local-only edited-preview, and the
 * `.v` marker sibling of each (module doc). All four share the same
 * verification rule — legitimate iff SOME live filename in this exact
 * directory hashes to the captured key — so they're one regex list instead
 * of one near-identical `if` per scheme. */
const HASH_KEYED_PREVIEW_SCHEMES: readonly RegExp[] = [
  LEGACY_PANO_PREVIEW_RE,
  EDITED_PREVIEW_RE,
  PREVIEW_VERSION_MARKER_RE,
  EDITED_PREVIEW_MARKER_RE,
];

/** A preview is orphaned unless it matches ONE of the live schemes: the
 * modern, path-keyed `<filename>.<suffix>` (via
 * `sourceFilenameForPreviewCacheName`), or one of the
 * `HASH_KEYED_PREVIEW_SCHEMES` (module doc) — the latter legitimate iff SOME
 * live filename in this exact directory hashes to the captured key. No
 * resolvable library id → no known-live set was (or safely could be) built
 * for this pass, so never delete — a transient failure to resolve the
 * library must not mass-delete live previews (see `resolveLibraryId`). */
function isOrphanPreview(
  libraryId: ObjectId | null,
  liveNames: ReadonlySet<string>,
  hashedLiveNames: () => ReadonlySet<string>,
  name: string,
): boolean {
  if (libraryId === null) return false;
  const source = sourceFilenameForPreviewCacheName(name);
  if (source !== null) return !liveNames.has(source);
  for (const scheme of HASH_KEYED_PREVIEW_SCHEMES) {
    const match = scheme.exec(name);
    if (match) return !hashedLiveNames().has(match[1]);
  }
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
async function sweepCacheDir(
  ctx: SweepContext,
  cacheDir: string,
  allowedExts: ReadonlySet<string>,
  isOrphan: (entryName: string) => boolean,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(cacheDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return; // ENOENT — fine, no cache here.
  }
  for (const entry of entries) {
    if (!entry.isFile() || !allowedExts.has(path.extname(entry.name))) continue;
    ctx.counters.scanned += 1;
    // Check the in-memory orphan verdict BEFORE touching the filesystem
    // again — a known/live file (the common case) never needs a stat call
    // at all, saving a syscall per file in every directory this sweeps
    // (jules review, PR #2006).
    if (!isOrphan(entry.name)) continue;
    const fullPath = path.join(cacheDir, entry.name);

    // TOCTOU defense: the known/live set was snapshotted before this walk
    // began. A stage may have written this file in the meantime. If the
    // file's mtime is within the recency window, defer to the next boot's
    // sweep.
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && ctx.now - stat.mtimeMs < RECENT_THRESHOLD_MS) {
      ctx.counters.skippedRecent += 1;
      continue;
    }

    if (await unlinkSafe(ctx, fullPath)) ctx.counters.deleted += 1;
  }
}

async function sweepThumbsDir(ctx: SweepContext, cacheDir: string, relDir: string): Promise<void> {
  // `knownPreviewFilenames` is really just "live filenames per directory" —
  // reused here for the pano-pre-seed legacy-scheme check, not previews
  // specifically (see `isOrphanThumb`'s doc).
  const liveNames = ctx.knownPreviewFilenames.get(relDir) ?? new Set<string>();
  const hashedLiveNames = lazyHashedNames(liveNames);
  await sweepCacheDir(ctx, cacheDir, THUMB_EXTS, (name) =>
    isOrphanThumb(ctx.knownMapleIds, ctx.libraryId, hashedLiveNames, name),
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
  const hashedLiveNames = lazyHashedNames(liveNames);
  await sweepCacheDir(ctx, cacheDir, PREVIEW_EXTS, (name) =>
    isOrphanPreview(ctx.libraryId, liveNames, hashedLiveNames, name),
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

/** Build the set of known maple_ids once (one query, DB-wide — a maple_id is
 * unique regardless of which library it lives in). Projection keeps the
 * working set tight even on 100k-asset libraries; iterating the cursor
 * avoids materialising the full result array as an intermediate. */
async function loadKnownMapleIds(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
): Promise<Set<string>> {
  const knownMapleIds = new Set<string>();
  const mapleIdCursor = coll.find(
    { maple_id: { $type: 'string' } },
    { projection: { maple_id: 1 } },
  );
  for await (const doc of mapleIdCursor) {
    if (typeof doc.maple_id === 'string') knownMapleIds.add(doc.maple_id);
  }
  return knownMapleIds;
}

/** Build the set of live (path, filename) pairs for one library — previews
 * are path-keyed per-location, not DB-wide unique like maple_id, so this
 * needs library scoping. `path` (POSIX-separated, matching `fileinfo.path`'s
 * own convention) maps to the set of live filenames at that exact
 * directory. */
async function loadKnownPreviewFilenames(
  coll: Awaited<ReturnType<typeof assetsCollection>>,
  libraryId: ObjectId,
): Promise<Map<string, Set<string>>> {
  const knownPreviewFilenames = new Map<string, Set<string>>();
  const fiCursor = coll.find(
    {
      fileinfo: {
        $elemMatch: { library_id: libraryId, deleted_at: null, missing_since: null },
      },
    },
    { projection: { fileinfo: 1 } },
  );
  for await (const doc of fiCursor) {
    for (const fi of (doc.fileinfo as FileInfoLocation[] | undefined) ?? []) {
      if (!fi.library_id.equals(libraryId) || fi.deleted_at || fi.missing_since) continue;
      const set = knownPreviewFilenames.get(fi.path) ?? new Set<string>();
      set.add(fi.filename);
      knownPreviewFilenames.set(fi.path, set);
    }
  }
  return knownPreviewFilenames;
}

export async function sweepOrphanedCaches(libraryRoot: string): Promise<SweepResult> {
  const coll = await assetsCollection();
  const knownMapleIds = await loadKnownMapleIds(coll);
  const libraryId = await resolveLibraryId(libraryRoot);
  const knownPreviewFilenames = libraryId
    ? await loadKnownPreviewFilenames(coll, libraryId)
    : new Map<string, Set<string>>();

  const ctx: SweepContext = {
    counters: {
      scanned: 0,
      deleted: 0,
      skippedRecent: 0,
      recentFailErrno: null,
      recentFailCount: 0,
    },
    now: Date.now(),
    knownMapleIds,
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
  return {
    scanned: ctx.counters.scanned,
    deleted: ctx.counters.deleted,
    skipped_recent: ctx.counters.skippedRecent,
  };
}
