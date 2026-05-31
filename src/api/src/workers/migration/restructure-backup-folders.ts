/**
 * Migration: "Restructure backup folders" (#744).
 *
 * Moves already-backed-up photos out of the now-retired `…/MM-DD/` day-folder
 * into the flatter `year/place/` (or `year/MM/`) layout. Scoped to backup-origin
 * assets — those carrying `phasset_links` — whose CANONICAL location
 * (`fileinfo[0]`) still sits in an old-layout 3-segment dir.
 *
 * Per asset the move is crash-safe (copy → verify → companions → DB repoint →
 * delete source → drop cache → reclaim folder); see `restructure-fs.ts` for the
 * ordering rationale. The DB write resets the `thumb`/`preview` stage versions
 * so the workers regenerate the dropped cache at the new path.
 */

import type { Collection, WithId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { OLD_LAYOUT_DIR_RE, restructureDir } from './restructure-path.ts';
import { finalize, planAndPlace, SourceMissingError } from './restructure-fs.ts';

const log = childLogger('migration:restructure');

/** Cache-writing stages keyed on the asset's path. Reset to v0 after a move so
 * the workers regenerate the dropped `.maple` cache at the new location. */
const CACHE_STAGES = ['thumb', 'preview'] as const;

/** Selects backup-origin assets whose canonical entry is an old-layout dir. */
function candidateFilter() {
  return {
    'phasset_links.0': { $exists: true },
    'fileinfo.0.deleted_at': null,
    'fileinfo.0.path': { $regex: OLD_LAYOUT_DIR_RE },
  } as const;
}

/** Build the surgical `$set` that repoints the canonical fileinfo entry to its
 * new (path, filename) and resets the cache stages. Mirrors `markSoftDeleted`'s
 * positional-arrayFilter update so a multi-location asset's other entries are
 * preserved. */
function buildRepointUpdate(args: {
  newPath: string;
  newFilename: string;
  newRenderedRel: string | null;
}) {
  const set: Record<string, unknown> = {
    'fileinfo.$[entry].path': args.newPath,
    'fileinfo.$[entry].filename': args.newFilename,
    apple_rendered_path: args.newRenderedRel,
  };
  for (const stage of CACHE_STAGES) {
    set[`stages.${stage}.version`] = 0;
    set[`stages.${stage}.attempts`] = 0;
    set[`stages.${stage}.last_error`] = null;
    set[`stages.${stage}.dead`] = false;
  }
  return set;
}

async function moveOne(
  coll: Collection<AssetDoc>,
  doc: WithId<AssetDoc>,
  libRoot: string,
): Promise<'moved' | 'skipped'> {
  const primary = doc.fileinfo?.[0];
  if (!primary || primary.deleted_at) return 'skipped';
  const oldDir = primary.path;
  const newDir = restructureDir(oldDir);
  if (!newDir) return 'skipped'; // not actually old-layout (regex over-match guard)

  // 1. Copy + verify the file and its companions into the new dir. Sources are
  //    NOT deleted yet.
  const plan = await planAndPlace({
    libRoot,
    oldDir,
    filename: primary.filename,
    newDir,
    renderedRelOld: doc.apple_rendered_path ?? null,
  });

  // 2. Repoint the DB to the new location (between verify and delete).
  const lastSlash = plan.newRelPath.lastIndexOf('/');
  const newPath = lastSlash === -1 ? '' : plan.newRelPath.slice(0, lastSlash);
  const newFilename = lastSlash === -1 ? plan.newRelPath : plan.newRelPath.slice(lastSlash + 1);
  await coll.updateOne(
    { _id: doc._id },
    {
      $set: buildRepointUpdate({
        newPath,
        newFilename,
        newRenderedRel: plan.newRenderedRel,
      }),
    } as never,
    {
      arrayFilters: [
        {
          'entry.library_id': primary.library_id,
          'entry.path': primary.path,
          'entry.filename': primary.filename,
        },
      ],
    },
  );

  if (plan.outcome === 'deduped') {
    log.info(
      { _id: String(doc._id), maple_id: doc.maple_id },
      'restructure: deduped against an existing byte-identical copy at the new path',
    );
  }

  // 3. Delete sources, drop stale cache, reclaim the empty old folder.
  await finalize({
    libRoot,
    oldDirAbs: plan.oldDirAbs,
    mapleId: doc.maple_id,
    filename: primary.filename,
    sourcesToDelete: plan.sourcesToDelete,
  });

  // 4. Reconcile any duplicate fileinfo entry the discover watcher may have
  //    added for the new path mid-move (it watches every registered folder,
  //    so the move's `add` event can push a second entry before our repoint;
  //    both stat present, so the reaper would never prune it). The old source
  //    is now deleted and the new path is on the row, so handle-event's
  //    "record location if not already present" guard suppresses any further
  //    re-add — making this single dedup pass stable.
  await dedupeLiveFileinfo(coll, doc._id);
  return 'moved';
}

/** Collapse exact-duplicate LIVE fileinfo entries (same library_id/path/
 * filename), keeping the first. A no-op when there are none. */
async function dedupeLiveFileinfo(coll: Collection<AssetDoc>, id: WithId<AssetDoc>['_id']): Promise<void> {
  const fresh = await coll.findOne({ _id: id }, { projection: { fileinfo: 1 } });
  const list = fresh?.fileinfo;
  if (!list || list.length < 2) return;
  const seen = new Set<string>();
  const deduped: FileInfo[] = [];
  for (const fi of list) {
    const key = `${fi.library_id.toHexString()}|${fi.path}|${fi.filename}|${fi.deleted_at ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fi);
  }
  if (deduped.length !== list.length) {
    await coll.updateOne({ _id: id }, { $set: { fileinfo: deduped } });
    log.info(
      { _id: String(id), removed: list.length - deduped.length },
      'restructure: collapsed duplicate fileinfo entries (discover-watcher race)',
    );
  }
}

export const restructureBackupFolders: Migration = {
  id: 'restructure-backup-folders',
  title: 'Restructure backup folders',
  description:
    'Move already-backed-up photos out of the old MM-DD day-folder into the ' +
    'flatter year/place (or year/month) layout. Copy-verify-delete, never ' +
    'overwrites; duplicates are deduped, name clashes get a numeric suffix.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }

    const docs = await coll
      .find(candidateFilter(), {
        projection: { _id: 1, fileinfo: 1, maple_id: 1, apple_rendered_path: 1 },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    for (const doc of docs) {
      const primary = (doc.fileinfo as FileInfo[] | undefined)?.[0];
      const root = primary ? libs.get(primary.library_id.toHexString()) : undefined;
      if (!root) {
        // Library unregistered / offline — skip without erroring; retried once a
        // tick until the mount returns. Never delete on an offline mount.
        continue;
      }
      try {
        const result = await moveOne(coll, doc, root);
        if (result === 'moved') processed++;
      } catch (err) {
        if (err instanceof SourceMissingError) {
          // Source gone from disk — nothing to move. Left for the reaper.
          log.warn({ _id: String(doc._id), err: err.message }, 'restructure: source missing — skipped');
          continue;
        }
        errors++;
        log.error(
          { _id: String(doc._id), err: err instanceof Error ? err.message : err },
          'restructure: asset move failed — left in place for retry',
        );
      }
    }
    return { processed, errors };
  },
};
