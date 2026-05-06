/**
 * Reference-preserving merge for keyed lists held in signals.
 *
 * When a bulk reload replaces a list with one whose contents are mostly
 * unchanged, naively returning the new list flips every item's reference
 * — every OnPush component bound to one of those items then re-evaluates,
 * even when the data is identical. That's the "whole table re-renders
 * when one cell changes" problem.
 *
 * `mergePreservingRefs` keeps the old reference when the new item compares
 * equal under `isEqual`, and only swaps in the new reference when content
 * actually differs. Callers downstream see a stable identity for unchanged
 * items, so OnPush + signal-based change detection only fires for items
 * whose data really moved.
 */

export function mergePreservingRefs<T extends { id: string }>(
  oldList: readonly T[],
  newList: readonly T[],
  isEqual: (a: T, b: T) => boolean,
): T[] {
  if (oldList.length === 0) return [...newList];
  const oldById = new Map<string, T>();
  for (const item of oldList) oldById.set(item.id, item);
  return newList.map((next) => {
    const prev = oldById.get(next.id);
    return prev && isEqual(prev, next) ? prev : next;
  });
}

/** Shallow equality across a fixed set of keys. Returns false if any key
 * differs by `Object.is`. Use for plain data records (no methods, no
 * nested object identity that matters for re-render correctness). */
export function shallowEqualByKeys<T>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  for (const k of keys) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}
