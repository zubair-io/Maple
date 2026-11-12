/**
 * ImportRunner — copies one import for one Temporal activity attempt (tickets
 * #742, #5819). The `imports` row is the queue; the worker tier relays it to
 * an `import-<id>` workflow, whose activity calls {@link ImportRunner.run}.
 * Nothing here polls.
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
 *   - Cancel, from the API or from Temporal, is observed BETWEEN files;
 *     already-copied files stay.
 */

import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { child as childLogger } from '../log.ts';
import { hashFileForId as realHashFileForId } from '../indexer/id.ts';
import { handleEvent as realHandleEvent } from '../workers/discover/handle-event.ts';
import { copyFileAtomic, resolveDest, destAbsPath } from './copy.ts';
import { buildImportFiles } from './scan.ts';
import { groupFiles } from './group-files.ts';
import {
  probeDuplicate,
  resumeLandedPrimary,
  type RecordFile,
  type ResumeSeams,
} from './resume.ts';
import {
  claimImport,
  updateImportProgress,
  setImportFiles,
  getImportFiles,
  completeImport,
  failImport,
  markImportCancelled,
  assetExistsForHash as realAssetExistsForHash,
  type ClaimedImport,
} from './repo.ts';
import {
  finishedImportRun,
  heartbeat,
  importStopRequested,
  keepImportAlive,
  type HeldImport,
} from './import-attempt.ts';
import { AttemptSuperseded, type RowAttempt } from '../temporal/activity-attempt.ts';
import type { RowRun } from '../temporal/row-workflow.ts';
import { loadNearbyAssetCandidates } from './nearby.ts';
import { rearmStageByFilenames } from '../db/repos/stage-state.repo.ts';
import { SIDECAR_METADATA_INDEX_STAGE_NAME } from '../workers/stages/sidecar-metadata-index.ts';
import type { ImportFileEntry } from '../db/schema.ts';

/** Well inside the five-minute heartbeat timeout of `ROW_ACTIVITY_OPTIONS`. */
const HEARTBEAT_EVERY_MS_DEFAULT = 100_000;
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
  rearmSidecarMetadataIndex: (imageFilename: string) => Promise<void>;
}

const DEFAULT_DEPS: ImportRunnerDeps = {
  hashFileForId: realHashFileForId,
  assetExistsForHash: realAssetExistsForHash,
  handleEvent: realHandleEvent,
  rearmSidecarMetadataIndex: async (imageFilename) => {
    await rearmStageByFilenames(SIDECAR_METADATA_INDEX_STAGE_NAME, [imageFilename]);
  },
};

export interface ImportRunnerConfig {
  /** How often a running import heartbeats while no file finishes. */
  heartbeatEveryMs?: number;
  deps?: Partial<ImportRunnerDeps>;
  now?: () => Date;
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
function remapSidecarDest(sidecarDestRel: string, origStem: string, newStem: string): string {
  const dir = path.posix.dirname(sidecarDestRel);
  const filename = path.posix.basename(sidecarDestRel);
  // The sidecar's canonical base equals origStem (it was paired on that), so
  // the filename starts with origStem. Swap just that prefix.
  const rest = filename.startsWith(origStem) ? filename.slice(origStem.length) : filename;
  return dir === '.' ? `${newStem}${rest}` : `${dir}/${newStem}${rest}`;
}

async function recordWholeGroup(
  record: RecordFile,
  files: ImportFileEntry[],
  pIdx: number,
  sidecarIdxs: number[],
  state: 'failed' | 'skipped_duplicate',
  error: string | null,
): Promise<void> {
  for (const sIdx of sidecarIdxs) {
    await record(sIdx, state, error, files[sIdx].dest);
  }
  await record(pIdx, state, error, files[pIdx].dest);
}

export class ImportRunner {
  private readonly heartbeatEveryMs: number;
  private readonly deps: ImportRunnerDeps;
  private readonly now: () => Date;

  constructor(config: ImportRunnerConfig = {}) {
    this.heartbeatEveryMs = config.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS_DEFAULT;
    this.deps = { ...DEFAULT_DEPS, ...config.deps };
    this.now = config.now ?? (() => new Date());
  }

  /** Runs one import for one activity attempt and reports how it stands afterwards. */
  async run(importId: string, attempt: RowAttempt): Promise<RowRun> {
    const id = new ObjectId(importId);
    const claim = await claimImport(id, attempt.identity, this.now);
    if (!claim) return finishedImportRun(id);
    const held: HeldImport = { claim, attempt, progress: { current: 0, total: 0 } };
    heartbeat(held);
    const stopKeepAlive = keepImportAlive(held, this.heartbeatEveryMs);
    try {
      return await this.processImport(held);
    } catch (err) {
      if (err instanceof AttemptSuperseded) throw err;
      const message = err instanceof Error ? err.message : String(err);
      await failImport(claim._id, message, this.now);
      return { outcome: 'failed', error: message };
    } finally {
      stopKeepAlive();
    }
  }

  private async processImport(held: HeldImport): Promise<RowRun> {
    const { claim } = held;
    const id = claim._id;

    // Auto Import: the create request deferred the scan to us. Walk the source
    // now (default `misc/<folder>` labels, or a nearby-asset/shot-folder match
    // — see `buildImportFiles`), persist the resolved files to `import_files`,
    // then copy as usual. The manual path's files were resolved up-front by
    // the create request and already live in `import_files`. Either way we
    // read them back from that table rather than off the claim — the file list
    // is a row per file and never a field on the import itself, which is what
    // keeps a folder of any size from being bounded by one record's size.
    const loaded = await this.loadFiles(claim);
    if ('result' in loaded) return loaded.result;
    const { files } = loaded;
    held.progress = { current: 0, total: files.length };

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
      await updateImportProgress(id, { index, state, error, destRel, current, counts }, this.now);
      held.progress = { current, total: files.length };
      heartbeat(held);
    };

    for (const pIdx of primaries) {
      if (await importStopRequested(held)) {
        await markImportCancelled(id, counts, this.now);
        return { outcome: 'cancelled' };
      }

      await this.processGroup(claim, files, pIdx, sidecars.get(pIdx) ?? [], record);
    }

    // Terminal status: an import that copied or skipped at least one file is
    // `done` (with a non-zero `counts.failed` surfacing the bad files). Only a
    // run where EVERYTHING failed (and at least one did) is `failed` — partial
    // success is not a failed import.
    if (counts.copied === 0 && counts.skipped === 0 && counts.failed > 0) {
      const error = `All ${counts.failed} file(s) failed to import.`;
      await failImport(id, error, this.now);
      log.warn({ importId: id.toHexString(), counts }, 'import failed: all files failed');
      return { outcome: 'failed', error };
    }
    await completeImport(id, counts, this.now);
    return { outcome: 'done' };
  }

  /** The import's file rows, scanning first for an Auto Import; `result` when it cannot proceed. */
  private async loadFiles(
    claim: ClaimedImport,
  ): Promise<{ files: ImportFileEntry[] } | { result: RowRun }> {
    if (!claim.scan_pending) return { files: await getImportFiles(claim._id) };
    const scanned = await buildImportFiles(
      claim.source_root,
      {},
      {
        loadNearbyCandidates: (minMs, maxMs) =>
          loadNearbyAssetCandidates(claim.library_id, minMs, maxMs),
      },
    );
    if (scanned.length === 0) {
      const error = `No importable photos, sidecars, or movies in ${claim.source_root}.`;
      await failImport(claim._id, error, this.now);
      return { result: { outcome: 'failed', error } };
    }
    await setImportFiles(claim._id, scanned, this.now);
    return { files: scanned };
  }

  /** Copies, skips or fails one primary together with its sidecars. */
  private async processGroup(
    claim: ClaimedImport,
    files: ImportFileEntry[],
    pIdx: number,
    sidecarIdxs: number[],
    record: RecordFile,
  ): Promise<void> {
    const id = claim._id;
    const primary = files[pIdx];

    // A pre-failed primary (e.g. an unsafe filename the scan couldn't build a
    // safe destination for — see buildImportFiles) must NOT be hashed or
    // copied: doing so would overwrite its `failed` state and feed an
    // unvalidated dest to the filesystem. Re-record it as failed (so counts
    // are right) and fail its sidecars via the existing `pr.state !== 'copied'`
    // branch below — never orphaning a sidecar next to an absent image.
    if (primary.state === 'failed') {
      await this.recordPreFailedGroup(id, files, pIdx, sidecarIdxs, record);
      return;
    }

    // A retry meets a primary that already landed. Re-hashing it would hit the
    // dedup check below and skip its still-pending sidecars as duplicates.
    if (primary.state === 'copied') {
      await resumeLandedPrimary({
        libraryRoot: claim.library_root,
        files,
        primaryIndex: pIdx,
        sidecarIndexes: sidecarIdxs,
        record,
        seams: this.resumeSeams(claim),
      });
      return;
    }

    // Dedup decision at the image. Movies never live in `assets`, so they
    // skip the hash check and rely on the on-disk identical-skip below.
    const probe = await probeDuplicate(this.deps, primary);
    if (probe.error !== null) {
      await recordWholeGroup(record, files, pIdx, sidecarIdxs, 'failed', probe.error);
      return;
    }

    if (probe.isDuplicate) {
      // Skip the image AND its sidecars — the image is already in the
      // library; a fresh sidecar copy would be orphaned.
      await recordWholeGroup(record, files, pIdx, sidecarIdxs, 'skipped_duplicate', null);
      return;
    }

    await this.copyGroup(claim, files, pIdx, sidecarIdxs, record);
  }

  /** Re-records a primary the scan already rejected, and fails its sidecars with it. */
  private async recordPreFailedGroup(
    id: ObjectId,
    files: ImportFileEntry[],
    pIdx: number,
    sidecarIdxs: number[],
    record: RecordFile,
  ): Promise<void> {
    const primary = files[pIdx];
    const reason = primary.error ?? 'rejected during scan';
    log.warn(
      { importId: id.toHexString(), src: primary.src, dest: primary.dest, reason },
      'skipping pre-failed import file',
    );
    await record(pIdx, 'failed', reason, primary.dest);
    for (const sIdx of sidecarIdxs) {
      await record(sIdx, 'failed', files[sIdx].error ?? reason, files[sIdx].dest);
    }
  }

  /** Copies a new primary, then its sidecars under the primary's resolved stem. */
  private async copyGroup(
    claim: ClaimedImport,
    files: ImportFileEntry[],
    pIdx: number,
    sidecarIdxs: number[],
    record: RecordFile,
  ): Promise<void> {
    const primary = files[pIdx];

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
      await this.handOffToIndexer(claim, claim._id, destAbsPath(claim.library_root, pr.destRel));
    }
  }

  private resumeSeams(claim: ClaimedImport): ResumeSeams {
    return {
      copyOne: (libraryRoot, src, destRel) => this.copyOne(libraryRoot, src, destRel),
      handOffToIndexer: (absPath) => this.handOffToIndexer(claim, claim._id, absPath),
      rearmSidecarIndex: async (imageFilename) => {
        try {
          await this.deps.rearmSidecarMetadataIndex(imageFilename);
        } catch (err) {
          log.warn(
            {
              importId: claim._id.toHexString(),
              imageFilename,
              err: err instanceof Error ? err.message : String(err),
            },
            'could not re-arm sidecar metadata indexing after a retried sidecar copy',
          );
        }
      },
    };
  }

  private async handOffToIndexer(
    claim: ClaimedImport,
    id: ObjectId,
    absPath: string,
  ): Promise<void> {
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
}
