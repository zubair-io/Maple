// Shared "Enter/Space activates" keydown handler for the Maple UI
// pressable-row/card molecules (mui-card, mui-list-row, mui-media-cell —
// unified-component-catalog.md §§2, 4): a `role="button"`-style element
// that's clickable and, for keyboard/AT users, also activates on Enter or
// Space. Not part of the public API surface (see ../public-api.ts).

/** Calls `activate` (and prevents the key's default scroll/submit
 * behavior) when `event` is Enter or Space; no-ops for any other key. */
export function handleActivationKeydown(event: KeyboardEvent, activate: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  activate();
}
