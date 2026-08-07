import { InjectionToken, Provider } from '@angular/core';

/**
 * Whether the folder-tree row context menu (New Folder / Rename / Move to
 * Trash) is available. Folder CRUD (`FolderCrudService`) operates on
 * registered filesystem libraries — a Self-Hosted-only concept — so it
 * defaults to `false` and only Self-Hosted's composition root turns it on,
 * mirroring `INFO_PANEL_EXTENSION` / `FOLDER_TREE_EXTENSIONS` (#2643 review:
 * the capability must not be statically reachable from Hosted).
 *
 * This token only gates whether the row handlers ever fire — it does not
 * itself pull in `FolderTreeCrudComponent`'s code. That component is
 * referenced from `folder-tree.component.ts` exclusively inside an `@defer`
 * block, so it (and the menu/dialog components + `FolderCrudService` it
 * imports) code-splits into its own chunk regardless of which app is
 * building, and is only ever fetched once a Self-Hosted user actually opens
 * the menu.
 */
export const FOLDER_TREE_CRUD_ENABLED = new InjectionToken<boolean>('FOLDER_TREE_CRUD_ENABLED', {
  providedIn: 'root',
  factory: () => false,
});

export function provideFolderTreeCrud(): Provider {
  return { provide: FOLDER_TREE_CRUD_ENABLED, useValue: true };
}
