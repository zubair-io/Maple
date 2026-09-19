/** Invalidate the selected on-disk copy, including non-primary deduplicated locations. */
import { ObjectId } from '../../db/object-id.ts';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { recordSidecarEditAtAddress } from '../../db/repos/assets.relocate.repo.ts';
import { recordAssetChangeRow } from '../../db/repos/changes.repo.ts';
import { getChangeBus } from '../../runtime/change-bus.ts';
import { getLibraryBySlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';

function contains(root: string, path: string): boolean {
  const canonicalRoot = resolve(root);
  return path.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
}

async function selectedLibrary(id: string, path: string) {
  const delimiter = id.indexOf(':');
  const named = delimiter > 0 ? await getLibraryBySlug(id.slice(0, delimiter)) : null;
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
  // Resolve the selected copy and bump its version atomically at publication
  // time, so relocation cannot redirect an earlier lookup to a different file.
  // Unlike fire-and-forget editor notifications, a persisted batch can recover
  // a failed publication. Keep its ledger prepared until the durable row exists.
  const assetId = library
    ? await recordSidecarEditAtAddress({
        libraryId: library.libraryId,
        path: relative(library.root, dirname(path)).split(sep).join('/'),
        filename: basename(path),
      })
    : null;
  const change = await recordAssetChangeRow(undefined, {
    kind: 'update',
    asset_id: assetId,
    folder_id: folderId,
    abs_path: path,
    relative_path: relativePath,
  });
  getChangeBus().publish(change);
}
