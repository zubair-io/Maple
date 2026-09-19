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
import type { ObjectId } from '../../db/object-id.ts';
import {
  hideAssetsInFolder,
  listFolderHideCandidates,
  listFolderUnhideCandidates,
  unhideAssetsInFolder,
  type FolderHiddenCandidate,
} from '../../db/repos/assets.folder-hidden.ts';
import type { FileInfo } from '../../db/schema.ts';
import { toPosixRelDir } from './types.ts';
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

/** Bound on how many asset rows are buffered per write round-trip, so a
 * marker dropped on a directory with tens of thousands of photos can't
 * balloon the sweeper's heap. */
const BATCH_SIZE = 1000;

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

  if (folderHidden) {
    const hidden = await forEachBatch(
      (after) => listFolderHideCandidates(folderId, rel, after, BATCH_SIZE),
      async (batch) => {
        const count = await hideAssetsInFolder(
          batch.map((a) => a.id),
          folderId,
          rel,
        );
        // Newly hidden: any thumbnail already mirrored to R2 must come down
        // (best-effort/non-throwing, see cloudflare/hidden-cleanup.ts).
        // Deliberately the whole batch, not only the modified rows: for a row
        // the guard skipped, the concurrent un-hide re-armed cf-thumb-sync, so
        // an extra R2 delete self-heals via re-mirror (and 404s are treated as
        // success by deleteThumbFromR2).
        await cleanupHidden(batch.map(toHidable));
        return count;
      },
    );
    if (hidden > 0) {
      log.info({ dir: dirPath, count: hidden }, 'folder .hidden marker: hid assets');
    }
    return;
  }

  const memo = new CoverageMemo();
  const unhidden = await forEachBatch(
    (after) => listFolderUnhideCandidates(folderId, rel, after, BATCH_SIZE),
    async (batch) => {
      const free: ObjectId[] = [];
      for (const candidate of batch) {
        if (!(await otherLiveEntryStillCovered(candidate, folderId, rel, memo))) {
          free.push(candidate.id);
        }
      }
      return unhideAssetsInFolder(free, folderId, rel);
    },
  );
  if (unhidden > 0) {
    log.info({ dir: dirPath, count: unhidden }, 'folder .hidden marker removed: un-hid assets');
  }
}

/** A candidate as `cloudflare/hidden-cleanup.ts` reads one. */
function toHidable(candidate: FolderHiddenCandidate): HidableAsset {
  return {
    _id: candidate.id,
    fileinfo: candidate.locations,
    cf_thumb_synced_at: candidate.cfThumbSyncedAt,
  };
}

/**
 * Walk the candidate set in bounded pages; returns the summed per-page counts.
 *
 * Paging is by id rather than by offset, and a page that changed nothing still
 * advances: the un-hide pass deliberately leaves some candidates hidden (their
 * other live location is still under a marked directory), so a loop that
 * re-asked for "the first thousand candidates" would never terminate.
 */
async function forEachBatch(
  page: (after: string) => Promise<FolderHiddenCandidate[]>,
  fn: (batch: FolderHiddenCandidate[]) => Promise<number>,
): Promise<number> {
  let total = 0;
  let after = '';
  for (;;) {
    const batch = await page(after);
    if (batch.length === 0) return total;
    total += await fn(batch);
    after = batch[batch.length - 1]!.id.toHexString();
  }
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
  candidate: FolderHiddenCandidate,
  folderId: ObjectId,
  rel: string,
  memo: CoverageMemo,
): Promise<boolean> {
  const others = candidate.locations.filter(
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
