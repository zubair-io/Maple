// Resolve the two actual authoring sources; no folder handle is needed on HTTP.
import type { Injector } from '@angular/core';
import type { LibraryStateService } from '../state/library-state.service';
import type { FolderAccessService } from '../folder-access/folder-access.service';
import type { XmpStoreService } from '../xmp/xmp-store.service';
import type { Asset } from '../models/asset';
import { LocalRemovalAssets } from './local-removal-assets';
import { savedRemovalRecords } from './saved-removal-records';

export async function removalEditorStorage(
  library: LibraryStateService,
  files: FolderAccessService,
  sidecars: XmpStoreService,
  injector: Injector,
  asset: Asset,
  xml: string,
) {
  const folder = library.currentFolder() ?? undefined;
  if (library.backend === 'self-hosted') {
    const [{ ServerRemovalSidecars }, { openServerRemovalAssets }] = await Promise.all([
      import('./server-removal-sidecars'),
      import('./server-removal-assets'),
    ]);
    const snapshot = await new ServerRemovalSidecars(library, injector).capture(asset.id);
    if (
      (snapshot.xml ? (savedRemovalRecords(snapshot.xml) ?? '[]') : '[]') !==
      (savedRemovalRecords(xml) ?? '[]')
    )
      throw new Error(
        'The server removal history changed. Reopen the photo to load its saved edits.',
      );
    const readOriginal = () => library.bytesForAsset(asset.id);
    return {
      folder,
      path: snapshot.path,
      readOriginal,
      sidecarRevision: snapshot.revision,
      assets: await openServerRemovalAssets(injector, snapshot.path, readOriginal),
    };
  }
  if (!folder?.native || !folder.write)
    throw new Error('AI removal requires a folder opened with filesystem write access.');
  return {
    folder,
    path: undefined,
    readOriginal: () => files.readFile(folder, asset.filename),
    sidecarRevision: await sidecars.captureRemovalRevision(asset.id, folder, asset.filename),
    assets: new LocalRemovalAssets(files, folder, asset.filename),
  };
}
