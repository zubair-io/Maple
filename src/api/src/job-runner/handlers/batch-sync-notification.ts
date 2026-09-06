/** Invalidate the selected on-disk copy, including non-primary deduplicated locations. */
import { ObjectId } from 'mongodb';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { assetChangesCollection, assetsCollection } from '../../db/client.ts';
import { recordSidecarEdit } from '../../db/assets.repo.ts';
import { recordAssetChange } from '../../db/changes.repo.ts';
import { getChangeBus } from '../../runtime/change-bus.ts';
import { getLibraryBySlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';

function contains(root: string, path: string): boolean {
  const canonicalRoot = resolve(root);
  return path.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
}

async function selectedLibrary(id: string, path: string) {
  const slug = id.slice(0, id.indexOf(':'));
  const named = await getLibraryBySlug(slug);
  if (named && contains(named.root, path)) return named;
  const matching = [...(await loadLibraryRoots())]
    .filter(([, root]) => contains(root, path))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return matching ? { libraryId: new ObjectId(matching[0]), root: matching[1] } : null;
}

export async function publishBatchSidecarEdit(id: string, path: string): Promise<void> {
  const library = await selectedLibrary(id, path);
  const folderId = library?.libraryId ?? null;
  const relativePath = library ? relative(library.root, path).split(sep).join('/') : null;
  const asset = library
    ? await (
        await assetsCollection()
      ).findOne(
        {
          fileinfo: {
            $elemMatch: {
              library_id: library.libraryId,
              path: relative(library.root, dirname(path)).split(sep).join('/'),
              filename: basename(path),
              deleted_at: null,
            },
          },
        },
        { projection: { _id: 1 } },
      )
    : null;
  if (asset) await recordSidecarEdit(asset._id);
  // Unlike fire-and-forget editor notifications, a persisted batch can recover
  // a failed publication. Keep its ledger prepared until the durable row exists.
  const cursor = await recordAssetChange(undefined, {
    kind: 'update',
    asset_id: asset?._id ?? null,
    folder_id: folderId,
    abs_path: path,
    relative_path: relativePath,
  });
  const change = await (await assetChangesCollection()).findOne({ cursor });
  if (!change) throw new Error('The batch sidecar notification was not persisted');
  getChangeBus().publish(change);
}
