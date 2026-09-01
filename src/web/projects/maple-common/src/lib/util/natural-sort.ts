/**
 * Natural (numeric-aware) string comparator for sorting file/folder names —
 * the `Array.prototype.sort` comparator shape, so callers pass it (or a
 * `.localeCompare`-shaped wrapper) directly.
 *
 * Plain `localeCompare` treats digit runs character-by-character, so "Trip
 * 10" sorts before "Trip 2". `{ numeric: true }` compares embedded digit
 * runs by numeric value instead (Finder/Explorer-standard ordering), and
 * `{ sensitivity: 'base' }` ignores case and accent differences so casing
 * (and diacritics — "café" vs "cafe") doesn't affect order. Mirrors Apple's
 * `localizedStandardCompare` (#2398) for cross-platform parity — see #2399.
 *
 * Backed by a module-level `Intl.Collator` rather than calling
 * `String#localeCompare` with an options object on every invocation:
 * `localeCompare` re-resolves and discards an equivalent collator each call,
 * which shows up in `.sort()` hot paths over folders with hundreds of
 * entries (Copilot review, PR #3111). `Intl.Collator#compare` is the
 * documented fast path for the exact same comparison.
 */
const NATURAL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return NATURAL_COLLATOR.compare(a, b);
}
