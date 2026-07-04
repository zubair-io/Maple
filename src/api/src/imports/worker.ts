/**
 * ImportRunner — the import worker (ticket #742).
 *
 * Mirrors `job-runner/runner.ts`, but the work queue is the `imports`
 * collection and the unit of work is a folder copy. Loop shape:
 *
 *     while (!shutdown) {
 *       const claim = await claimImport(...);
 *       if (!claim) { sleep(POLL_MS); continue; }
 *       await processImport(claim, ...);   // per-file copy + indexer hand-off
 *     }
 *
 * Per-file semantics:
 *   - Files are processed grouped by image: an image's `.xmp` sidecars are
 *     copied first, then the image, then the image is handed to the indexer
 *     via `handleEvent`. Movies are copied but never indexed (watcher is
 *     image-only, v1).
 *   - Dedup decision is at the image: `hashFileForId` → `assetExistsForHash`
 *     (maple_id then sha1_head). A duplicate image AND its sidecars are
 *     skipped — copying an orphan sidecar for an image already in the library
 *     would be meaningless.
 *   - On-disk name collisions resolve to a free sibling; byte-identical files
 *     already present are skipped.
 *   - Cancel is observed BETWEEN files; already-copied files stay.
 *
 * Concurrency: one import at a time per runner (the proposed v1 default,
 * matching JobRunner). Poll/lease are constants (no env vars); there is no
 * operator-facing import config in v1. If a pause/concurrency knob is wanted
 * later it should live in the `worker_config` collection (`name: 'import'`)
 * with a control on /settings/workers — not a new env var.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';
import { canonicalBaseFromSidecarFilename } from '../fs/browse.ts';
import { hashFileForId as realHashFileForId } from '../indexer/id.ts';
import { handleEvent as realHandleEvent } from '../workers/discover/handle-event.ts';
import { copyFileAtomic, resolveDest, destAbsPath } from './copy.ts';
import { buildImportFiles } from './scan.ts';
import {
  claimImport,
  updateImportProgress,
  renewImportLease,
  setImportFiles,
  getImportFiles,
  completeImport,
  failImport,
  markImportCancelled,
  isImportCancelRequested,
  assetExistsForHash as realAssetExistsForHash,
  type ClaimedImport,
} from './repo.ts';
import { loadNearbyAssetCandidates } from './nearby.ts';
import type { ImportFileEntry } from '../db/schema.ts';

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 5 * 60 * 1_000;
/** Max no-clobber publish attempts before a file is marked failed (each
 * attempt re-resolves a fresh sibling; only a sustained adversarial racer
 * exhausts this). */
const PUBLISH_RETRIES = 25;

const log = childLogger('import-worker');

/** Injectable seams — defaults point at the real implementations; tests
 * override the heavy/external ones (indexer hand-off, asset dedup, hash). */
export interface ImportRunnerDeps {
  hashFileForId: typeof realHashFileForId;
  assetExistsForHash: typeof realAssetExistsForHash;
  handleEvent: typeof realHandleEvent;
}

const DEFAULT_DEPS: ImportRunnerDeps = {
  hashFileForId: realHashFileForId,
  assetExistsForHash: realAssetExistsForHash,
  handleEvent: realHandleEvent,
};

export interface ImportRunnerConfig {
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  deps?: Partial<ImportRunnerDeps>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type ImportTickResult =
  | { kind: 'no-claim' }
  | { kind: 'done'; importId: string }
  | { kind: 'cancelled'; importId: string }
  | { kind: 'failed'; importId: string; error: string };

interface FileGroups {
  /** Indices of primary entries (image/movie), in files[] order. */
  primaries: number[];
  /** primary index → its sidecar entry indices. */
  sidecars: Map<number, number[]>;
}

/**
 * Group a flat files[] by primary: each primary (image/movie) maps to its
 * sidecars, paired on destination directory + the key its sidecar resolves to
 * (image stem for `IMG_1.xmp`, full video filename for `clip.mov.xmp`). Pure —
 * unit tested directly.
 */
export function groupFiles(files: ImportFileEntry[]): FileGroups {
  const primaries: number[] = [];
  const primaryByKey = new Map<string, number>();
  const sidecars = new Map<number, number[]>();

  // Register every primary and the key its sidecar resolves to. Videos use the
  // full-name sidecar convention (`clip.mov.xmp`), so they key on the full
  // filename, not the stem — a Live Photo's motion clip can never collide with
  // its same-stem still (M5 — #1635). Single pass: distinct keys, no contest.
  files.forEach((f, i) => {
    if (f.kind === 'sidecar') return;
    primaries.push(i);
    sidecars.set(i, []);
    const dir = path.posix.dirname(f.dest);
    const name = path.posix.basename(f.dest);
    const base = f.kind === 'movie' ? name : path.posix.basename(name, path.posix.extname(name));
    primaryByKey.set(`${dir}\0${base}`, i);
  });

  files.forEach((f, i) => {
    if (f.kind !== 'sidecar') return;
    const dir = path.posix.dirname(f.dest);
    const base = canonicalBaseFromSidecarFilename(path.posix.basename(f.dest));
    const parent = base ? primaryByKey.get(`${dir}\0${base}`) : undefined;
    // buildImportFiles only emits sidecars attached to a primary, so this is
    // defensive — an unattachable sidecar is dropped rather than copied.
    if (parent !== undefined) sidecars.get(parent)!.push(i);
  });

  return { primaries, sidecars };
}

/** POSIX stem (basename without extension) of a rel path. */
function stemOf(destRel: string): string {
  const base = path.posix.basename(destRel);
  return base.slice(0, base.length - path.posix.extname(base).length);
}

/**
 * Rewrite a sidecar's destination so its stem follows the image's RESOLVED
 * stem after a collision rename. The sidecar filename is
 * `<origStem><suffix>.xmp` (suffix is the optional ` (conflict from …)` part);
 * only the leading stem is swapped, preserving the conflict-copy suffix.
 *
 *   remapSidecarDest('2024/03/IMG.xmp', 'IMG', 'IMG-1')
 *     → '2024/03/IMG-1.xmp'
 *   remapSidecarDest('2024/03/IMG (conflict from Mac).xmp', 'IMG', 'IMG-1')
 *     → '2024/03/IMG-1 (conflict from Mac).xmp'
 */
export function remapSidecarDest(
  sidecarDestRel: string,
  origStem: string,
  newStem: string,
): string {
  const dir = path.posix.dirname(sidecarDestRel);
  const filename = path.posix.basename(sidecarDestRel);
  // The sidecar's canonical base equals origStem (it was paired on that), so
  // the filename starts with origStem. Swap just that prefix.
  const rest = filename.startsWith(origStem) ? filename.slice(origStem.length) : filename;
  return dir === '.' ? `${newStem}${rest}` : `${dir}/${newStem}${rest}`;
}

export class ImportRunner {
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly deps: ImportRunnerDeps;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(config: ImportRunnerConfig = {}) {
    this.workerId =
      config.workerId ?? `import-worker-${process.pid}-${randomBytes(8).toString('hex')}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.deps = { ...DEFAULT_DEPS, ...config.deps };
    this.now = config.now ?? (() => new Date());
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.loopPromise) return;
    this.shuttingDown = false;
    this.loopPromise = this.runLoop().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'loop crashed');
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  /** Single iteration. Exposed for tests. */
  async tick(): Promise<ImportTickResult> {
    const claim = await claimImport(this.workerId, this.leaseMs, this.now);
    if (!claim) return { kind: 'no-claim' };
    // Heartbeat the lease independently of per-file progress so a single
    // large file/movie copy that runs longer than the lease can't be
    // reclaimed mid-copy by a sibling runner.
    const stopHeartbeat = this.startHeartbeat(claim._id);
    try {
      return await this.processImport(claim);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failImport(claim._id, message, this.now);
      return { kind: 'failed', importId: claim._id.toHexString(), error: message };
    } finally {
      stopHeartbeat();
    }
  }

  /** Renew the claim's lease on a timer (every ~leaseMs/3) until stopped.
   * Returns a function that clears the timer. */
  private startHeartbeat(id: ObjectId): () => void {
    const everyMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const handle = setInterval(() => {
      void renewImportLease(id, this.leaseMs, this.now).catch(() => {
        // A transient Mongo error here is non-fatal — the next tick renews,
        // or the lease lapses and another runner legitimately takes over.
      });
    }, everyMs);
    // Don't keep the process alive solely for the heartbeat.
    handle.unref?.();
    return () => clearInterval(handle);
  }

  private async processImport(claim: ClaimedImport): Promise<ImportTickResult> {
    const id = claim._id;

    // Auto Import: the create request deferred the scan to us. Walk the source
    // now (default `misc/<folder>` labels, or a nearby-asset/shot-folder match
    // — see `buildImportFiles`), persist the resolved files to `import_files`,
    // then copy as usual. The manual path's files were resolved up-front by
    // the create request and already live in `import_files`. Either way we
    // pull them back from the collection (NOT off the claim doc) — they were
    // moved out of the import doc so a huge folder can't overflow it.
    let files: ImportFileEntry[];
    if (claim.scan_pending) {
      const scanned = await buildImportFiles(
        claim.source_root,
        {},
        {
          loadNearbyCandidates: (minMs, maxMs) =>
            loadNearbyAssetCandidates(claim.library_id, minMs, maxMs),
        },
      );
      if (scanned.length === 0) {
        await failImport(
          id,
          `No importable photos, sidecars, or movies in ${claim.source_root}.`,
          this.now,
        );
        return { kind: 'failed', importId: id.toHexString(), error: 'no importable files' };
      }
      await setImportFiles(id, scanned, this.leaseMs, this.now);
      files = scanned;
    } else {
      files = await getImportFiles(id);
    }

    const { primaries, sidecars } = groupFiles(files);
    const counts = { copied: 0, skipped: 0, failed: 0 };
    let current = 0;

    const record = async (
      index: number,
      state: ImportFileEntry['state'],
      error: string | null,
      destRel: string,
    ): Promise<void> => {
      if (state === 'copied') counts.copied += 1;
      else if (state === 'skipped_duplicate') counts.skipped += 1;
      else if (state === 'failed') {
        counts.failed += 1;
        // Structured failure log — reaches SigNoz via the pino → otel-logs
        // bridge (log.ts multistream) when an OTLP target is configured.
        log.warn(
          { importId: id.toHexString(), src: files[index]?.src, dest: destRel, reason: error },
          'import file failed',
        );
      }
      current += 1;
      await updateImportProgress(
        id,
        { index, state, error, destRel, current, counts },
        this.leaseMs,
        this.now,
      );
    };

    for (const pIdx of primaries) {
      if (await isImportCancelRequested(id)) {
        await markImportCancelled(id, counts, this.now);
        return { kind: 'cancelled', importId: id.toHexString() };
      }

      const primary = files[pIdx];
      const sidecarIdxs = sidecars.get(pIdx) ?? [];

      // A pre-failed primary (e.g. an unsafe filename the scan couldn't build a
      // safe destination for — see buildImportFiles) must NOT be hashed or
      // copied: doing so would overwrite its `failed` state and feed an
      // unvalidated dest to the filesystem. Re-record it as failed (so counts
      // are right) and fail its sidecars via the existing `pr.state !== 'copied'`
      // branch below — never orphaning a sidecar next to an absent image.
      if (primary.state === 'failed') {
        const reason = primary.error ?? 'rejected during scan';
        log.warn(
          { importId: id.toHexString(), src: primary.src, dest: primary.dest, reason },
          'skipping pre-failed import file',
        );
        await record(pIdx, 'failed', reason, primary.dest);
        for (const sIdx of sidecarIdxs) {
          await record(sIdx, 'failed', files[sIdx].error ?? reason, files[sIdx].dest);
        }
        continue;
      }

      // Dedup decision at the image. Movies never live in `assets`, so they
      // skip the hash check and rely on the on-disk identical-skip below.
      let isDuplicate = false;
      if (primary.kind === 'image') {
        try {
          const h = await this.deps.hashFileForId(primary.src);
          isDuplicate = await this.deps.assetExistsForHash(h.maple_id, h.sha1_head);
        } catch (err) {
          // A hash failure (unreadable source) fails just this group.
          const msg = err instanceof Error ? err.message : String(err);
          for (const sIdx of sidecarIdxs) {
            await record(sIdx, 'failed', msg, files[sIdx].dest);
          }
          await record(pIdx, 'failed', msg, primary.dest);
          continue;
        }
      }

      if (isDuplicate) {
        // Skip the image AND its sidecars — the image is already in the
        // library; a fresh sidecar copy would be orphaned.
        for (const sIdx of sidecarIdxs) {
          await record(sIdx, 'skipped_duplicate', null, files[sIdx].dest);
        }
        await record(pIdx, 'skipped_duplicate', null, primary.dest);
        continue;
      }

      // Copy the PRIMARY first so the sidecars can follow its RESOLVED stem.
      // If an on-disk collision renamed `IMG.dng` → `IMG-1.dng`, the sidecar
      // must become `IMG-1.xmp` or the edits detach from their image
      // (invariant #1: the sidecar is the contract). See remapSidecarDest.
      const pr = await this.copyOne(claim.library_root, primary.src, primary.dest);
      await record(pIdx, pr.state, pr.error, pr.destRel);

      const origStem = stemOf(primary.dest);
      const newStem = stemOf(pr.destRel);

      for (const sIdx of sidecarIdxs) {
        if (pr.state !== 'copied') {
          // Image was skipped (identical already present) or failed — never
          // orphan the sidecar by copying it next to an absent/other image.
          await record(
            sIdx,
            pr.state === 'failed' ? 'failed' : 'skipped_duplicate',
            pr.error,
            files[sIdx].dest,
          );
          continue;
        }
        const scDest =
          newStem === origStem
            ? files[sIdx].dest
            : remapSidecarDest(files[sIdx].dest, origStem, newStem);
        const r = await this.copyOne(claim.library_root, files[sIdx].src, scDest);
        await record(sIdx, r.state, r.error, r.destRel);
      }

      // Hand the image to the indexer only if it actually landed. Its
      // sidecars are already on disk under the resolved stem.
      if (primary.kind === 'image' && pr.state === 'copied') {
        const absPath = destAbsPath(claim.library_root, pr.destRel);
        try {
          await this.deps.handleEvent(
            { kind: 'created', absPath },
            claim.library_id,
            claim.library_root,
          );
        } catch (err) {
          log.warn(
            {
              importId: id.toHexString(),
              absPath,
              err: err instanceof Error ? err.message : String(err),
            },
            'indexer hand-off failed (file copied, will be picked up on next scan)',
          );
        }
      }
    }

    // Terminal status: an import that copied or skipped at least one file is
    // `done` (with a non-zero `counts.failed` surfacing the bad files). Only a
    // run where EVERYTHING failed (and at least one did) is `failed` — partial
    // success is not a failed import.
    if (counts.copied === 0 && counts.skipped === 0 && counts.failed > 0) {
      const error = `All ${counts.failed} file(s) failed to import.`;
      await failImport(id, error, this.now);
      log.warn({ importId: id.toHexString(), counts }, 'import failed: all files failed');
      return { kind: 'failed', importId: id.toHexString(), error };
    }
    await completeImport(id, counts, this.now);
    return { kind: 'done', importId: id.toHexString() };
  }

  /** Copy `src` to `destRel` under the library, resolving on-disk collisions.
   * Never throws — returns the per-file outcome so one bad file doesn't abort
   * the import. Retries when a no-clobber publish loses a cross-process race
   * for the destination (re-resolving a free sibling from the base path). */
  private async copyOne(
    libraryRoot: string,
    src: string,
    destRel: string,
  ): Promise<{
    state: ImportFileEntry['state'];
    error: string | null;
    destRel: string;
  }> {
    try {
      for (let attempt = 0; attempt < PUBLISH_RETRIES; attempt++) {
        const resolved = await resolveDest(libraryRoot, destRel, src);
        if (resolved.alreadyPresent) {
          return { state: 'skipped_duplicate', error: null, destRel: resolved.destRel };
        }
        const destAbs = destAbsPath(libraryRoot, resolved.destRel);
        const published = await copyFileAtomic(src, destAbs);
        if (published) {
          return { state: 'copied', error: null, destRel: resolved.destRel };
        }
        // Lost the race for `resolved.destRel` to another writer — re-resolve
        // from the base path (the now-occupied sibling is skipped next pass).
      }
      return {
        state: 'failed',
        error: `could not publish ${destRel} after ${PUBLISH_RETRIES} attempts`,
        destRel,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
        destRel,
      };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      let result: ImportTickResult;
      try {
        result = await this.tick();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tick error');
        result = { kind: 'no-claim' };
      }
      if (result.kind === 'no-claim') {
        await this.sleep(this.pollMs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton glue (start/stop from src/index.ts)
// ---------------------------------------------------------------------------

let _singleton: ImportRunner | null = null;

/** Start the process-wide ImportRunner. Idempotent. */
export function startImportRunner(config?: ImportRunnerConfig): ImportRunner {
  if (_singleton) return _singleton;
  _singleton = new ImportRunner(config);
  _singleton.start();
  log.info('started');
  return _singleton;
}

/** Stop the process-wide ImportRunner. Safe to call when not started. */
export async function stopImportRunner(): Promise<void> {
  if (!_singleton) return;
  log.info('stopping');
  await _singleton.stop();
  _singleton = null;
  log.info('stopped');
}

export function _resetImportRunnerForTests(): void {
  _singleton = null;
}

export { ObjectId };
