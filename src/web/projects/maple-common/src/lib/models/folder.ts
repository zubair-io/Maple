// Folder domain model — mirrors the tree shape in _design-reference/lib/data.jsx.

export interface Folder {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  assetCount: number | null;
}

export interface FolderTreeNode {
  folder: Folder;
  children: FolderTreeNode[];
}

// The sidebar tree also has "smart" virtual collections and albums.
// We model them generically so the tree component can render all entry types.
// 'trash' (#2652): the per-library Trash pseudo-node the folder-tree renders
// as a sibling of each registered library root, visually set apart from
// real folders. Not part of `LibraryStateService`'s persisted `sidebarTree`
// signal — it's synthesized in the folder-tree component template from
// `TrashCapability.available()` + `LibraryStateService.registeredFolders()`,
// so it never needs its own tree-mutation plumbing.
export type SidebarEntryKind = 'folder' | 'smart' | 'album' | 'section' | 'subheader' | 'trash';

export interface SidebarEntry {
  kind: SidebarEntryKind;
  id: string;
  label: string;
  count: number | null;
  icon?: string; // for smart items
  smart?: boolean; // for smart albums
  open?: boolean; // default open state for folder nodes
  children?: SidebarEntry[];
  /**
   * Absolute filesystem path on disk (Self-Hosted FS-walk tree only). Set on
   * registered-library roots and on every lazy-loaded subfolder so the
   * folder-tree can call FilesystemBrowseService.listDir(node.absPath) on
   * expand/select.
   */
  absPath?: string;
  /**
   * Children-load lifecycle (Self-Hosted FS-walk tree only):
   *   undefined → not yet fetched
   *   'loading' → /api/fs/dir is in flight
   *   'loaded'  → `children` reflects the directory contents
   *   'error'   → fetch failed; show retry affordance
   */
  childrenStatus?: 'loading' | 'loaded' | 'error';
  /** Last error message when childrenStatus === 'error'. */
  childrenError?: string;
}

// Folder rendered as a navigable tile inside the asset grid (Self-Hosted
// only). Sits alongside Asset records in the grid layout — clicking
// one drills into the folder via the same `openSelfHostedSubfolder` path
// the sidebar uses, so navigation logic stays in one place.
//
// After M2 the `id` is the full `slug:relPath` MapleAddress string.
// `absPath` is kept as an optional legacy field for backward compat with
// the asset-grid component (which passes it as `relPath` to
// `openSelfHostedSubfolder`); new listings from LibrarySource omit it.
export interface GridFolderItem {
  id: string;
  name: string;
  absPath?: string;
  parentSourceId: string;
  aspectRatio: number;
}
