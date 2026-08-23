// Shared "click text to edit inline, Enter commits, Escape cancels" logic for
// the Maple UI single-field inline editors (mui-description-field,
// mui-place-row — unified-component-catalog.md §3). Not part of the public
// API surface (see ../public-api.ts).

import type { WritableSignal } from '@angular/core';

/** Enter commits, Escape cancels — the shared keydown contract every
 * inline-edit molecule in this library uses. */
export function handleEditKeydown(
  event: KeyboardEvent,
  commit: () => void,
  cancel: () => void,
): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
}

/** Commits a trimmed draft: closes editing, and — unless the trimmed value
 * is unchanged (or, when `allowEmpty` is false, empty) — writes it back
 * through `current` and returns the committed value so the caller can emit
 * its own `committed` output. Returns `null` when nothing should be
 * emitted. */
export function commitEditDraft(
  draft: string,
  currentValue: string,
  current: WritableSignal<string>,
  editing: WritableSignal<boolean>,
  allowEmpty: boolean,
): string | null {
  editing.set(false);
  const next = draft.trim();
  if (next === currentValue) return null;
  if (!allowEmpty && next.length === 0) return null;
  current.set(next);
  return next;
}
