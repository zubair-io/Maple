/**
 * Hash stage — derives sha1_head, size, mtime, and the maple:id (fallback form).
 *
 * After PR 2 of the content-addressing migration the discover watcher already
 * hashes inline at insert time and pre-bumps `stages.hash.version` to its
 * target, so this stage is a no-op for newly-discovered rows. The handler
 * stays in the manifest to handle two pre-existing populations:
 *
 *   - Legacy skeleton rows inserted by an older discover that wrote
 *     `maple_id: null` — those still need a backfill pass.
 *   - Rows whose `stages.hash.version` was reset to zero (e.g. by the
 *     folder-rescan route).
 *
 * The primary form (tag 0x01, needs EXIF capturedAt + camera serial) is
 * finalised by the exif stage after `readExif` populates those fields.
 *
 * dependsOn: []   — first stage in the graph; no prerequisites.
 */
import { hashFileForId } from '../../indexer/id.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';

const hashStage = defineStage({
  name: 'hash',
  targetVersion: 1,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image: ImageDoc): Promise<StageResult> => {
    // PR 2: discover writes maple_id + sha1_head + size + mtime inline at
    // insert time, and pre-bumps stages.hash.version to the target so this
    // stage is skipped on the next claim poll. Legacy rows (maple_id is
    // null/absent) still flow through here.
    //
    // Short-circuit only when ALL four fields are populated. A row inserted
    // by an older backup-ingest (which wrote maple_id but not sha1_head)
    // would otherwise mark `stages.hash.version` complete without ever
    // computing sha1_head/size/mtime — silently breaking the stage contract.
    if (image.maple_id && image.sha1_head && image.size && image.mtime) {
      return { patch: {} };
    }
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }
    const absPath = assetAbsPath(image, libs) ?? (image.abs_path as string | undefined);
    if (!absPath) {
      return { skip: 'no-resolvable-location' };
    }
    const { maple_id, sha1_head, size, mtime } = await hashFileForId(absPath);
    return {
      patch: { sha1_head, size, mtime, maple_id },
    };
  },
});

export default hashStage;

export async function startHashStage(): Promise<RunStageHandle> {
  return runStage(hashStage);
}
