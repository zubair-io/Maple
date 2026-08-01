import { InjectionToken, Provider, Type } from '@angular/core';

/** Optional app-owned controls rendered above the shared folder rows. */
export const FOLDER_TREE_EXTENSION = new InjectionToken<Type<unknown> | null>(
  'FOLDER_TREE_EXTENSION',
  { providedIn: 'root', factory: () => null },
);

export function provideFolderTreeExtension(component: Type<unknown>): Provider {
  return { provide: FOLDER_TREE_EXTENSION, useValue: component };
}
