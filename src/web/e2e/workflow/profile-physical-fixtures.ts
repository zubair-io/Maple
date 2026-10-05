import type { ApplicationRef } from '@angular/core';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';

/** Settle authored XMP before destroying either real profile qualification app. */
export async function disposeProfileFixture(active: { app: ApplicationRef; host: HTMLElement }) {
  const library = active.app.injector.get(LibraryStateService);
  const id = library.focusedAssetId();
  if (id) await active.app.injector.get(XmpStoreService).settleAsset(id);
  active.app.destroy();
  active.host.remove();
}

/** Reopening a named OPFS folder retains its authored sidecar and original bytes. */
export async function stageProfileFixture(
  app: ApplicationRef,
  files: string[],
  prefix: 'maple-auto-fit-' | 'maple-cold-profile-',
  name?: string,
) {
  const root = await navigator.storage.getDirectory();
  const folderName = name ?? prefix + crypto.randomUUID();
  const native = await root.getDirectoryHandle(folderName, { create: true });
  const folder = { native, name: folderName, read: true, write: true };
  const access = app.injector.get(FolderAccessService);
  if (!name)
    for (const filename of files) {
      const response = await fetch('/physical-raw/' + filename);
      if (!response.ok) throw Error('Missing physical fixture: ' + filename);
      await access.writeFile(folder, filename, new Uint8Array(await response.arrayBuffer()));
    }
  return folder;
}
