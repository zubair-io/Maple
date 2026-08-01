import { InjectionToken, Provider, Type } from '@angular/core';

export interface FolderTreeExtensions {
  readonly header: Type<unknown>;
  readonly body: Type<unknown>;
}

/** Optional app-owned controls for the shared folder-tree layout slots. */
export const FOLDER_TREE_EXTENSIONS = new InjectionToken<FolderTreeExtensions | null>(
  'FOLDER_TREE_EXTENSIONS',
  { providedIn: 'root', factory: () => null },
);

export function provideFolderTreeExtensions(extensions: FolderTreeExtensions): Provider {
  return { provide: FOLDER_TREE_EXTENSIONS, useValue: extensions };
}
