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
export type SidebarEntryKind = 'folder' | 'smart' | 'album' | 'section' | 'subheader';

export interface SidebarEntry {
  kind: SidebarEntryKind;
  id: string;
  label: string;
  count: number | null;
  icon?: string;         // for smart items
  smart?: boolean;       // for smart albums
  open?: boolean;        // default open state for folder nodes
  children?: SidebarEntry[];
}
