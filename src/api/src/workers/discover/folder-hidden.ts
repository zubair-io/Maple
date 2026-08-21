/**
 * Folder-level `.hidden` marker reconciliation (#2972). A `.hidden` file in a
 * library directory hides every photo in that directory and its subtree
 * (`hidden: true, hidden_reason: 'folder'`); removing the marker un-hides
 * exactly the assets it hid. Runs once per directory per sweep, from
 * `visitDirectory` — the sweep is what makes the marker a live signal rather
 * than an ingest-time-only one.
 *
 * Precedence mirrors the nudity precedent: an explicit per-photo XMP override
 * (`metadata_override.hidden`) wins in both directions — an override-visible
 * asset is never folder-hidden, and an override-hidden asset is never
 * folder-un-hidden. Manual and nudity hides are untouched by marker removal
 * (only `hidden_reason: 'folder'` rows un-hide). Folder hides are
 * operator-initiated (the operator created the file), so `hidden_ack` is
 * never set and the assets stay out of the AI-review list — same as manual.
 */
import path from 'node:path';
import type { ObjectId, WithId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { toPosixRelDir } from './types.ts';
import { invalidationSets } from '../stage-config.ts';
import {
  cleanupR2ThumbsForHiddenAssets,
  type HidableAsset,
} from '../../cloudflare/hidden-cleanup.ts';
import { child } from '../../log.ts';

const log = child('discover');

/** Exact filename of the folder-level marker. Distinct from the per-photo
 * sibling markers (`<photo>.hidden`, `fs/hidden-marker.ts`) — those are an
 * outbound mirror of DB state; this file is an inbound operator signal. */
export const FOLDER_HIDDEN_MARKER = '.hidden';

/** Injectable R2-cleanup seam for tests; production always uses the real
 * bulk cleanup (`cloudflare/hidden-cleanup.ts` requires a call on every
 * write path that can flip `hidden` to true). */
export type CleanupHidden = (assets: HidableAsset[]) => Promise<void>;

/**
 * Reconcile one directory's assets against its effective folder-hidden state
 * (`own marker present || hidden_ancestor`). Targeted queries — in the steady
 * state (no marker change since the last sweep) the hide pass matches nothing
 * and the un-hide pass modifies nothing, so sweeps stay write-free.
 */
export async function reconcileFolderHidden(
  folderId: ObjectId,
  root: string,
  dirPath: string,
  folderHidden: boolean,
  cleanupHidden: CleanupHidden = cleanupR2ThumbsForHiddenAssets,
): Promise<void> {
  const rel = toPosixRelDir(path.relative(root, dirPath));
  const inDir = {
    deleted_at: null,
    fileinfo: { $elemMatch: { library_id: folderId, path: rel } },
  };
  const coll = await assetsCollection();

  if (folderHidden) {
    const toHide = (await coll
      .find(
        { ...inDir, hidden: { $ne: true }, 'metadata_override.hidden': { $ne: false } },
        { projection: { fileinfo: 1, cf_thumb_synced_at: 1 } },
      )
      .toArray()) as Array<Pick<WithId<AssetDoc>, '_id' | 'fileinfo' | 'cf_thumb_synced_at'>>;
    if (toHide.length === 0) return;
    await coll.updateMany({ _id: { $in: toHide.map((a) => a._id) } }, {
      $set: {
        hidden: true,
        hidden_reason: 'folder',
        // The hidden flag is a Meilisearch filter — re-project the document.
        ...invalidationSets(['meili'], 'discover'),
      },
    } as never);
    // Newly hidden: any thumbnail already mirrored to R2 must come down
    // (best-effort/non-throwing, see cloudflare/hidden-cleanup.ts).
    await cleanupHidden(toHide);
    log.info({ dir: dirPath, count: toHide.length }, 'folder .hidden marker: hid assets');
    return;
  }

  const res = await coll.updateMany(
    { ...inDir, hidden_reason: 'folder', 'metadata_override.hidden': { $ne: true } },
    {
      $set: {
        hidden: false,
        hidden_reason: null,
        // Re-arm cf-thumb-sync: its `{ skip: 'hidden' }` marked itself done,
        // so without a reset an un-hidden asset would never re-mirror to R2
        // (same rationale as the un-hide path in sidecar-metadata-index).
        ...invalidationSets(['meili', 'cf-thumb-sync'], 'discover'),
      },
    } as never,
  );
  if (res.modifiedCount > 0) {
    log.info(
      { dir: dirPath, count: res.modifiedCount },
      'folder .hidden marker removed: un-hid assets',
    );
  }
}
