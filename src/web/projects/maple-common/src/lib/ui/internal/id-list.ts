// Shared "toggle a string id into/out of a list" helper for the Maple UI
// molecules that track a set of open/expanded ids as a plain array signal
// (mui-adjustments-panel, mui-filter-panel, mui-sidebar —
// unified-component-catalog.md §§2, 4). Not part of the public API surface
// (see ../public-api.ts).

/** Adds `id` to `ids` when `include` is true, removes it otherwise — the
 * shared body of every `toggleGroup`/`onExpandedChange`-style handler that
 * tracks open/expanded ids as a plain string array. */
export function toggleId(ids: readonly string[], id: string, include: boolean): readonly string[] {
  return include ? [...ids, id] : ids.filter((x) => x !== id);
}
