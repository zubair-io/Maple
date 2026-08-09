// Pure helpers backing the folder-tree's synthesized Trash pseudo-node
// (#2652) — split out of `folder-tree.component.ts` so that already-tight
// file stays small. No Angular DI here on purpose: these are plain
// functions the component calls with its own injected state.

import type { ApiFolder } from '../workspace/server-library-io';
import { parseAddress } from '../addressing/maple-address';
import type { TrashCount } from './trash.types';

/** Resolve the registered library a top-level (`level === 0`) folder-tree
 * row addresses — same slug-then-id fallback `FolderTreeCrudComponent` uses
 * for the same lookup (`resolveLibraryId`). Returns `null` for anything
 * that isn't a real M2-addressed library root (legacy `fs:` roots, smart
 * items, albums) — those never get a Trash row. */
export function libraryIdForRootNode(nodeId: string, folders: readonly ApiFolder[]): string | null {
  if (!nodeId.includes(':') || nodeId.startsWith('fs:')) return null;
  const addr = parseAddress(nodeId);
  if (addr.relPath !== '') return null; // only a library ROOT gets a Trash row
  const folder = folders.find((f) => f.slug === addr.slug || f.id === addr.slug);
  return folder?.id ?? null;
}

/** Badge text for a library's Trash row — `null` when the count hasn't
 * loaded yet (no badge rendered), `"12"` for a known exact count, `"100+"`
 * when the count page filled up (`TrashCount.capped`). */
export function trashCountLabel(count: TrashCount | undefined): string | null {
  if (!count) return null;
  if (count.count === 0) return null;
  return count.capped ? `${count.count}+` : String(count.count);
}
