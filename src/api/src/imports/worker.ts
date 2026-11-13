/**
 * ImportRunner — copies one import for one Temporal activity attempt (tickets
 * #742, #5819). The `imports` row is the queue; the worker tier relays it to
 * an `import-<id>` workflow, whose activity calls {@link ImportRunner.run}.
 * Nothing here polls.
 *
 * Per-file semantics:
 *   - Files are processed grouped by image: the image is copied first, then
 *     its `.xmp` sidecars under the name the image landed at, then the image
 *     is handed to the indexer via `handleEvent`. Movies are copied but never
 *     indexed (watcher is image-only, v1).
 *   - Dedup decision is at the image: `hashFileForId` → `assetExistsForHash`
 *     (maple_id then sha1_head). A duplicate image AND its sidecars are
 *     skipped — copying an orphan sidecar for an image already in the library
 *     would be meaningless.
 *   - On-disk name collisions resolve to a free sibling; byte-identical files
 *     already present are skipped.
 *   - Before an image or movie is published, its row is marked with the name
 *     it is about to land under, and the marker is cleared when the group
 *     ends. A later attempt that finds one looks at the marked name: a file
 *     already there with the source's bytes counts as copied and the group's
 *     sidecars and indexer hand-off follow.
 *   - Cancel, from the API or from Temporal, is observed BETWEEN files;
 *     already-copied files stay.
 */

import { ObjectId } from '../db/object-id.ts';
import { child as childLogger } from '../log.ts';
import { hashFileForId as realHashFileForId } from '../indexer/id.ts';
import { handleEvent as realHandleEvent } from '../workers/discover/handle-event.ts';
import { destAbsPath } from './copy.ts';
import { buildImportFiles } from './scan.ts';
import { groupFiles } from './group-files.ts';
import { holdsSource, publishFile } from './publish.ts';
import { PublishMarks } from './publish-marks.ts';
import {
  probeDuplicate,
  resumeLandedPrimary,
  type RecordFile,
  type ResumeSeams,
} from './resume.ts';
import { renamedSidecars, sidecarDestsBeside } from './sidecar-dest.ts';
import {
  claimImport,
  updateImportProgress,
  setImportFiles,
  getImportFiles,
  completeImport,
  failImport,
  markImportCancelled,
  ImportTakenOver,
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

type PrimaryOutcome = ImportFileEntry['state'];

/**
 * The marker a primary's outcome leaves, written with the outcome so no stop
 * can fall between the two. A later retry trusts a file it finds at a marked
 * name, so a group that ends without a copy gives its marker up: after a
 * failure, nothing of this attempt's is at the name it marked. What survives is
 * the name an earlier attempt marked, because that attempt may still be
 * running and land its copy there, or the name could not be read.
 */
function markerAfter(state: PrimaryOutcome, earlierDest: string | null): string | null | undefined {
  if (state === 'copied') return undefined;
  return state === 'failed' ? earlierDest : null;
}

interface GroupRun {
  claim: ClaimedImport;
  files: ImportFileEntry[];
  pIdx: number;
  sidecarIdxs: number[];
  record: RecordFile;
  marks: PublishMarks;
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
      if (err instanceof AttemptSuperseded || err instanceof ImportTakenOver) throw err;
      const message = err instanceof Error ? err.message : String(err);
      await failImport(claim._id, message, this.now, undefined, attempt.identity);
      return { outcome: 'failed', error: message };
    } finally {
      stopKeepAlive();
    }
  }

  private async processImport(held: HeldImport): Promise<RowRun> {
    const { claim } = held;
    const id = claim._id;
    const holder = held.attempt.identity;

    // Auto Import: the create request deferred the scan to us. Walk the source
    // now (default `misc/<folder>` labels, or a nearby-asset/shot-folder match
    // — see `buildImportFiles`), persist the resolved files to `import_files`,
    // then copy as usual. The manual path's files were resolved up-front by
    // the create request and already live in `import_files`. Either way we
    // read them back from that table rather than off the claim — the file list
    // is a row per file and never a field on the import itself, which is what
    // keeps a folder of any size from being bounded by one record's size.
    const loaded = await this.loadFiles(claim, holder);
    if ('result' in loaded) return loaded.result;
    const { files } = loaded;
    const marks = await PublishMarks.load(id, holder);
    held.progress = { current: 0, total: files.length };

    const { primaries, sidecars } = groupFiles(files);
    const counts = { copied: 0, skipped: 0, failed: 0 };
    let current = 0;

    const record: RecordFile = async (index, state, error, destRel, withIt) => {
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
        { index, state, error, destRel, current, counts, holder, ...withIt },
        this.now,
      );
      held.progress = { current, total: files.length };
      heartbeat(held);
    };

    for (const pIdx of primaries) {
      if (await importStopRequested(held)) {
        await markImportCancelled(id, counts, this.now, undefined, holder);
        return { outcome: 'cancelled' };
      }

      const sidecarIdxs = sidecars.get(pIdx) ?? [];
      const ended = await this.processGroup({ claim, files, pIdx, sidecarIdxs, record, marks });
      if (ended === 'copied') await marks.finish(pIdx);
    }

    // Terminal status: an import that copied or skipped at least one file is
    // `done` (with a non-zero `counts.failed` surfacing the bad files). Only a
    // run where EVERYTHING failed (and at least one did) is `failed` — partial
    // success is not a failed import.
    if (counts.copied === 0 && counts.skipped === 0 && counts.failed > 0) {
      const error = `All ${counts.failed} file(s) failed to import.`;
      await failImport(id, error, this.now, undefined, holder);
      log.warn({ importId: id.toHexString(), counts }, 'import failed: all files failed');
      return { outcome: 'failed', error };
    }
    await completeImport(id, counts, this.now, undefined, holder);
    return { outcome: 'done' };
  }

  /** The import's file rows, scanning first for an Auto Import; `result` when it cannot proceed. */
  private async loadFiles(
    claim: ClaimedImport,
    holder: string,
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
      await failImport(claim._id, error, this.now, undefined, holder);
      return { result: { outcome: 'failed', error } };
    }
    await setImportFiles(claim._id, scanned, this.now, undefined, holder);
    return { files: scanned };
  }

  private async processGroup(group: GroupRun): Promise<PrimaryOutcome> {
    const { files, pIdx, marks } = group;
    const primary = files[pIdx];

    // A pre-failed primary (e.g. an unsafe filename the scan couldn't build a
    // safe destination for — see buildImportFiles) must NOT be hashed or
    // copied: doing so would overwrite its `failed` state and feed an
    // unvalidated dest to the filesystem. Re-record it as failed (so counts
    // are right) and fail its sidecars with it — never orphaning a sidecar
    // next to an absent image.
    if (primary.state === 'failed') return this.recordPreFailedGroup(group);

    // A retry meets a primary that already landed. Re-hashing it would hit the
    // dedup check below and skip its still-pending sidecars as duplicates.
    if (primary.state === 'copied') return this.resumeGroup(group, primary.dest);

    const earlierDest = marks.earlierDest(pIdx);
    const settled = await this.settleWithoutCopying(group, earlierDest);
    return settled ?? this.copyGroup(group, earlierDest);
  }

  private async settleWithoutCopying(
    group: GroupRun,
    earlierDest: string | null,
  ): Promise<PrimaryOutcome | null> {
    const { files, pIdx } = group;
    const landed = await this.landedAt(group, earlierDest);
    if (landed !== null) return this.settleLanded(group, landed);

    // Dedup decision at the image. Movies never live in `assets`, so they
    // skip the hash check and rely on the on-disk identical-skip in the copy.
    const probe = await probeDuplicate(this.deps, files[pIdx]);
    if (probe.error !== null) return this.recordGroupAs(group, 'failed', probe.error);
    if (!probe.isDuplicate) return null;

    // The earlier attempt can have landed its copy, and the sweep catalogued
    // it, while this one was hashing: that is this import's file, not a
    // duplicate of it.
    const landedSince = await this.landedAt(group, earlierDest);
    if (landedSince !== null) return this.settleLanded(group, landedSince);
    // Skip the image AND its sidecars — the image is already in the
    // library; a fresh sidecar copy would be orphaned.
    return this.recordGroupAs(group, 'skipped_duplicate', null);
  }

  private async landedAt(
    group: GroupRun,
    earlierDest: string | null,
  ): Promise<{ dest: string } | { error: string } | null> {
    if (earlierDest === null) return null;
    const { claim, files, pIdx } = group;
    try {
      const holds = await holdsSource(claim.library_root, earlierDest, files[pIdx].src);
      return holds ? { dest: earlierDest } : null;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private settleLanded(
    group: GroupRun,
    landed: { dest: string } | { error: string },
  ): Promise<PrimaryOutcome> {
    return 'error' in landed
      ? this.recordGroupAs(group, 'failed', landed.error)
      : this.resumeGroup(group, landed.dest);
  }

  private async recordGroupAs(
    group: GroupRun,
    state: 'failed' | 'skipped_duplicate',
    error: string | null,
  ): Promise<PrimaryOutcome> {
    const { files, pIdx, sidecarIdxs, record, marks } = group;
    for (const sIdx of sidecarIdxs) {
      await record(sIdx, state, error, files[sIdx].dest);
    }
    await record(pIdx, state, error, files[pIdx].dest, {
      publishingDest: markerAfter(state, marks.earlierDest(pIdx)),
    });
    return state;
  }

  private async resumeGroup(group: GroupRun, landedDest: string): Promise<PrimaryOutcome> {
    const { claim, files, pIdx, sidecarIdxs, record, marks } = group;
    await resumeLandedPrimary({
      libraryRoot: claim.library_root,
      files,
      primaryIndex: pIdx,
      sidecarIndexes: sidecarIdxs,
      record,
      landedDest,
      interrupted: marks.earlierDest(pIdx) !== null,
      seams: this.resumeSeams(claim, marks),
    });
    return 'copied';
  }

  private async recordPreFailedGroup(group: GroupRun): Promise<PrimaryOutcome> {
    const { claim, files, pIdx, sidecarIdxs, record } = group;
    // The marker is left alone: a row is failed at load either from the scan,
    // which never marks, or from a write that settled its marker already.
    const primary = files[pIdx];
    const reason = primary.error ?? 'rejected during scan';
    log.warn(
      { importId: claim._id.toHexString(), src: primary.src, dest: primary.dest, reason },
      'skipping pre-failed import file',
    );
    await record(pIdx, 'failed', reason, primary.dest);
    for (const sIdx of sidecarIdxs) {
      await record(sIdx, 'failed', files[sIdx].error ?? reason, files[sIdx].dest);
    }
    return 'failed';
  }

  /** Copies a new primary, then its sidecars under the primary's resolved stem. */
  private async copyGroup(group: GroupRun, earlierDest: string | null): Promise<PrimaryOutcome> {
    const { claim, files, pIdx, sidecarIdxs, record, marks } = group;
    const primary = files[pIdx];

    const pr = await publishFile(claim.library_root, primary.src, primary.dest, {
      earlierDest,
      beforePublish: (destRel) => marks.mark(pIdx, destRel),
    });
    if (pr.landedEarlier) return this.resumeGroup(group, pr.destRel);

    // The sidecars follow the primary's RESOLVED stem, in the rows and on disk
    // (invariant #1: the sidecar is the contract). See sidecar-dest.ts.
    const sidecarDests = sidecarDestsBeside(files, pIdx, sidecarIdxs, pr.destRel);
    await record(pIdx, pr.state, pr.error, pr.destRel, {
      sidecarDests: pr.state === 'copied' ? renamedSidecars(files, sidecarDests) : [],
      publishingDest: markerAfter(pr.state, earlierDest),
    });

    for (const sidecar of sidecarDests) {
      if (pr.state !== 'copied') {
        // Image was skipped (identical already present) or failed — never
        // orphan the sidecar by copying it next to an absent/other image.
        await record(
          sidecar.index,
          pr.state === 'failed' ? 'failed' : 'skipped_duplicate',
          pr.error,
          files[sidecar.index].dest,
        );
        continue;
      }
      const r = await publishFile(claim.library_root, files[sidecar.index].src, sidecar.destRel);
      await record(sidecar.index, r.state, r.error, r.destRel);
    }

    // Hand the image to the indexer only if it actually landed. Its
    // sidecars are already on disk under the resolved stem.
    if (primary.kind === 'image' && pr.state === 'copied') {
      await this.handOffToIndexer(claim, claim._id, destAbsPath(claim.library_root, pr.destRel));
    }
    return pr.state;
  }

  private resumeSeams(claim: ClaimedImport, marks: PublishMarks): ResumeSeams {
    return {
      markPublishing: (index, destRel) => marks.mark(index, destRel),
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
}
