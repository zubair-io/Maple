// folder-tree-row.ts — the per-row booleans a folder-tree PARENT derives for
// its children (#2847 review finding, the #2520 fan-out shape reintroduced).
//
// `FolderTreeNodeComponent` used to `inject(LibraryStateService)` and
// recompute `isOpen` / `isSelected` against the whole shared `folderOpen()`
// map and `selectedSourceId()` per node — two computeds subscribed to the
// same two signals in EVERY rendered row, leaves included, so one chevron
// click or one source switch re-evaluated all of them in an unvirtualized
// tree. The asset grid's parent-derives-once idiom is the fix precedent:
// the parent reads the shared state once per pass, derives one boolean pair
// per child, and each row only reads its own `open` / `selected` inputs.
// Only rows that actually render children (an expanded folder) subscribe at
// all; a collapsed folder or a leaf subscribes to nothing.

import type { SidebarEntry } from '../../models/folder';

/** What one `<app-folder-tree-node>` needs from its parent: the entry plus
 * the two booleans the parent derived for it. */
export interface FolderTreeRow {
  readonly node: SidebarEntry;
  readonly open: boolean;
  readonly selected: boolean;
}

/** A user toggle in the shared `folderOpen` map wins; otherwise the entry's
 * own `open` default (top-level libraries start open, subfolders closed). */
export function resolveFolderOpen(
  openMap: Readonly<Record<string, boolean>>,
  node: SidebarEntry,
): boolean {
  const override = openMap[node.id];
  return override !== undefined ? override : node.open === true;
}

/** The folder rows under `children`, each with its `open` / `selected`
 * resolved once here. Pre-filtered to `kind === 'folder'` so the template's
 * recursion loop stays a flat `@for` with no per-child `@if` (#2749 review). */
export function deriveFolderRows(
  children: readonly SidebarEntry[] | undefined,
  openMap: Readonly<Record<string, boolean>>,
  selectedSourceId: string,
): FolderTreeRow[] {
  return (children ?? [])
    .filter((child) => child.kind === 'folder')
    .map((node) => ({
      node,
      open: resolveFolderOpen(openMap, node),
      selected: selectedSourceId === node.id,
    }));
}
