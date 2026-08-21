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
 *
 * Deduplicated assets (one doc, several live locations) hide when ANY live
 * location sits under a marked directory, and un-hide only when NONE does —
 * without the coverage check in `otherLiveEntryStillCovered`, a dup living in
 * both a marked and an unmarked dir would flip-flop every sweep generation,
 * thrashing Meilisearch re-indexing and R2 thumbnail delete/upload cycles.
 */
import path from 'node:path';
import type { Collection, FindCursor, ObjectId, WithId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';
import { toPosixRelDir } from './types.ts';
import { invalidationSets } from '../stage-config.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { libraryRootAvailable, statKind } from '../missing-reaper.helpers.ts';
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

/** Entry-level liveness, matching `liveFileInfoElemMatch` in
 * `indexer/images.repo.ts` — a trashed or missing path must neither apply
 * nor lift the folder-hidden state on an otherwise-live asset. */
const LIVE_ENTRY = { deleted_at: { $in: [null] }, missing_since: { $in: [null] } };

/** Bound on how many asset docs are buffered per write round-trip, so a
 * marker dropped on a directory with tens of thousands of photos can't
 * balloon the sweeper's heap. */
const BATCH_SIZE = 1000;

type CandidateDoc = Pick<WithId<AssetDoc>, '_id' | 'fileinfo' | 'cf_thumb_synced_at'>;

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
    fileinfo: { $elemMatch: { library_id: folderId, path: rel, ...LIVE_ENTRY } },
  };
  const coll = await assetsCollection();

  if (folderHidden) {
    const cursor = coll
      .find(
        { ...inDir, hidden: { $ne: true }, 'metadata_override.hidden': { $ne: false } },
        { projection: { fileinfo: 1, cf_thumb_synced_at: 1 } },
      )
      .batchSize(BATCH_SIZE) as unknown as FindCursor<CandidateDoc>;
    const hidden = await forEachBatch(cursor, (batch) => hideBatch(coll, batch, cleanupHidden));
    if (hidden > 0) {
      log.info({ dir: dirPath, count: hidden }, 'folder .hidden marker: hid assets');
    }
    return;
  }

  const cursor = coll
    .find(
      { ...inDir, hidden_reason: 'folder', 'metadata_override.hidden': { $ne: true } },
      { projection: { fileinfo: 1 } },
    )
    .batchSize(BATCH_SIZE) as unknown as FindCursor<CandidateDoc>;
  const memo = new CoverageMemo();
  const unhidden = await forEachBatch(cursor, async (batch) => {
    const free: ObjectId[] = [];
    for (const doc of batch) {
      if (!(await otherLiveEntryStillCovered(doc, folderId, rel, memo))) free.push(doc._id);
    }
    if (free.length === 0) return 0;
    // The write filter repeats the cursor's predicates (not just `_id`): a
    // concurrent writer — most plausibly the sidecar projection landing a
    // manual override — may have changed the doc between the read and this
    // write, and the guard turns the stale un-hide into a no-op instead of
    // stomping the newer state.
    const res = await coll.updateMany(
      {
        _id: { $in: free },
        deleted_at: null,
        hidden_reason: 'folder',
        'metadata_override.hidden': { $ne: true },
      },
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
    return res.modifiedCount;
  });
  if (unhidden > 0) {
    log.info({ dir: dirPath, count: unhidden }, 'folder .hidden marker removed: un-hid assets');
  }
}

/** Drain a cursor in bounded batches; returns the summed per-batch counts. */
async function forEachBatch(
  cursor: FindCursor<CandidateDoc>,
  fn: (batch: CandidateDoc[]) => Promise<number>,
): Promise<number> {
  let total = 0;
  let batch: CandidateDoc[] = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      total += await fn(batch);
      batch = [];
    }
  }
  if (batch.length > 0) total += await fn(batch);
  return total;
}

async function hideBatch(
  coll: Collection<AssetDoc>,
  batch: CandidateDoc[],
  cleanupHidden: CleanupHidden,
): Promise<number> {
  // The write filter repeats the cursor's predicates (not just `_id`) so a
  // doc changed between the read and this write — a concurrent manual
  // un-hide landing via the sidecar projection, say — is left alone rather
  // than stomped back to hidden (which, with the marker still present,
  // would then stick until the sidecar stage next re-ran).
  const res = await coll.updateMany(
    {
      _id: { $in: batch.map((a) => a._id) },
      deleted_at: null,
      hidden: { $ne: true },
      'metadata_override.hidden': { $ne: false },
    },
    {
      $set: {
        hidden: true,
        hidden_reason: 'folder',
        // The hidden flag is a Meilisearch filter — re-project the document.
        ...invalidationSets(['meili'], 'discover'),
      },
    } as never,
  );
  // Newly hidden: any thumbnail already mirrored to R2 must come down
  // (best-effort/non-throwing, see cloudflare/hidden-cleanup.ts).
  // Deliberately the whole batch, not only the modified docs: for a doc the
  // guard skipped, the concurrent un-hide re-armed cf-thumb-sync, so an
  // extra R2 delete self-heals via re-mirror (and 404s are treated as
  // success by deleteThumbFromR2).
  await cleanupHidden(batch);
  return res.modifiedCount;
}

/** Per-reconcile stat memoization — dup candidates in one directory tend to
 * share their other locations, so each (library, dir) marker chain and each
 * foreign root's availability is checked at most once per visit. */
class CoverageMemo {
  readonly chainCovered = new Map<string, boolean>();
  readonly rootUsable = new Map<string, boolean>();
}

/**
 * True when any OTHER live location of the asset still sits under a
 * folder-hidden directory, i.e. un-hiding now would be wrong. Conservative on
 * uncertainty, mirroring the missing-reaper: a stat error or an unavailable
 * library root (unmounted share ENOENTs every child) keeps the asset hidden
 * for this sweep rather than risking a hide/un-hide flap.
 */
async function otherLiveEntryStillCovered(
  doc: CandidateDoc,
  folderId: ObjectId,
  rel: string,
  memo: CoverageMemo,
): Promise<boolean> {
  const others = (doc.fileinfo ?? []).filter(
    (e) =>
      e.deleted_at == null &&
      e.missing_since == null &&
      !(e.library_id.equals(folderId) && e.path === rel),
  );
  if (others.length === 0) return false;
  const roots = await loadLibraryRoots();
  for (const entry of others) {
    if (await entryUnderHiddenDir(entry, roots, memo)) return true;
  }
  return false;
}

async function entryUnderHiddenDir(
  entry: FileInfo,
  roots: ReadonlyMap<string, string>,
  memo: CoverageMemo,
): Promise<boolean> {
  const libHex = entry.library_id.toHexString();
  const entryRoot = roots.get(libHex);
  // Unknown library (deleted/unregistered): the location can't carry a
  // checkable marker, so it doesn't keep the asset hidden.
  if (!entryRoot) return false;

  const key = `${libHex}:${entry.path}`;
  const cachedChain = memo.chainCovered.get(key);
  if (cachedChain !== undefined) return cachedChain;

  const usable =
    memo.rootUsable.get(libHex) ??
    (await libraryRootAvailable(entryRoot).then((ok) => {
      memo.rootUsable.set(libHex, ok);
      return ok;
    }));
  // Root not listable/empty ⇒ every child ENOENTs; "no marker found" would
  // be meaningless. Keep the asset hidden until the root is back.
  if (!usable) {
    memo.chainCovered.set(key, true);
    return true;
  }

  const covered = await dirChainHasMarker(entryRoot, entry.path);
  memo.chainCovered.set(key, covered);
  return covered;
}

/** Stat `.hidden` at the library root and every ancestor of `relDir` down to
 * the entry's own directory. `'present'` ⇒ covered; `'error'` ⇒ conservative
 * covered (see above); `'absent'` ⇒ keep walking. */
async function dirChainHasMarker(root: string, relDir: string): Promise<boolean> {
  const segments = relDir === '' ? [] : relDir.split('/');
  let dir = root;
  if ((await statKind(path.join(dir, FOLDER_HIDDEN_MARKER))) !== 'absent') return true;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    if ((await statKind(path.join(dir, FOLDER_HIDDEN_MARKER))) !== 'absent') return true;
  }
  return false;
}
