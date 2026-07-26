// Shared sidebar-source selection for BrowseShell (#2280).
//
// The inline folder tree (FolderTreeComponent, tablet+) and the phone
// source-picker drawer both need the same FS-walk-vs-plain-id branch when a
// source is chosen: an FS-walk / M2-addressed folder loads its contents into
// the grid and attaches its subdirs as tree children in one shot, while a
// smart collection / album / legacy root is a plain id select. The tree's
// click handler had the full `SidebarEntry` (so it read `node.absPath`
// directly); the drawer only has the entry's `id`.
//
// This is a pure free function over LibraryStateService's already-public
// surface (`sidebarTree()`, `openSelfHostedSubfolder`, `setFolderOpen`,
// `selectedSourceId`) so both callers share one path without adding members
// to the state/store facades.

import type { LibraryStateService } from '../../state/library-state.service';
import type { SidebarEntry } from '../../models/folder';
import { parseAddress } from '../../addressing/maple-address';

/** Depth-first search for the entry with `id` in a sidebar tree. */
function findEntry(entries: readonly SidebarEntry[], id: string): SidebarEntry | null {
  for (const e of entries) {
    if (e.id === id) return e;
    const hit = e.children ? findEntry(e.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * Select a sidebar entry by id — FS-walk subfolder (fetch + expand) or a
 * plain id select (smart collection, album, legacy root). Mirrors the branch
 * `FolderTreeComponent.onFolderClick` previously inlined, resolving `absPath`
 * from the entry in `state.sidebarTree()` since the drawer only has the id.
 */
export function selectSidebarEntry(state: LibraryStateService, id: string): void {
  const absPath = findEntry(state.sidebarTree(), id)?.absPath;
  if (absPath || id.includes(':')) {
    // After M2, id is `slug:relPath`; derive relPath from it when there's no
    // explicit absPath.
    const relPath = absPath ?? (id.includes(':') ? tryParseRelPath(id) : '');
    state.openSelfHostedSubfolder(relPath, id);
    state.setFolderOpen(id, true);
    return;
  }
  state.selectedSourceId.set(id);
}

/** Parse the relPath out of a `slug:relPath` id, or '' for legacy/unparseable ids. */
function tryParseRelPath(id: string): string {
  try {
    return parseAddress(id).relPath;
  } catch {
    // Legacy id or unparseable — fall through with an empty relPath.
    return '';
  }
}
