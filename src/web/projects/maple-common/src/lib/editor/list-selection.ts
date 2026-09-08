// list-selection.ts — the shared half of "delete the Nth item and keep the
// selection sane", used by every canvas tool whose model value is an ordered
// list: the mask layer stack (#1541) and the repair spot list (#3409).
//
// Only the bookkeeping is shared. Each session keeps its own undo
// description, its own commit class and its own write, because a mask layer
// and a repair spot are different things being deleted.

/** The list after removing `index`, and which index should now be selected. */
export interface ListRemoval<T> {
  readonly next: T[];
  /** The next selection: the item that slid into `index`, the new last item,
   *  or null when nothing is left. */
  readonly selected: number | null;
}

/**
 * Remove `index` from `list`. Returns null — and the caller does nothing,
 * pushing no undo entry — when `index` is out of range.
 */
export function removeAt<T>(list: readonly T[], index: number): ListRemoval<T> | null {
  if (index < 0 || index >= list.length) return null;
  const next = list.filter((_, i) => i !== index);
  return { next, selected: next.length === 0 ? null : Math.min(index, next.length - 1) };
}
