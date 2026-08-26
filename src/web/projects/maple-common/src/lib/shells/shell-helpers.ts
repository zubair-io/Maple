// shell-helpers.ts — small pure/near-pure helpers shared by the shell
// components (EditorShellComponent, PreviewShellComponent). Extracted to
// kill duplicate-code findings between the two shells (fallow duplication
// gate) rather than each carrying its own byte-identical copy.

import type { Asset } from '../models/asset';
import type { LibraryStateService } from '../state/library-state.service';

/** Last path segment of a `/`-delimited filename (e.g. `2026/a.jpg` → `a.jpg`).
 * Falls back to the input unchanged when there's no `/` to split on. */
export function basenameOf(filename: string): string {
  const parts = filename.split('/');
  return parts[parts.length - 1] ?? filename;
}

/**
 * After hydrating a filesystem-addressed asset that wasn't yet in the
 * session (`synth`), open its parent folder in the Self Hosted folder tree
 * so the sidebar reflects where the deep-linked file actually lives.
 *
 * No-ops for non-filesystem assets (`fs:` ids) and synthesized records that
 * carry no `absPath` — both are addresses this can't resolve a parent
 * directory from.
 */
export function openHydratedFsParent(state: LibraryStateService, synth: Asset): void {
  if (synth.id.startsWith('fs:') || !synth.absPath) return;
  const lastSlash = synth.absPath.lastIndexOf('/');
  if (lastSlash < 0) return;
  const parentDir = lastSlash === 0 ? '/' : synth.absPath.slice(0, lastSlash);
  state.openSelfHostedSubfolder(parentDir, synth.folderId, synth.id);
}
