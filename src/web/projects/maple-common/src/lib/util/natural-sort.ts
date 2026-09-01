/**
 * Natural (numeric-aware) string comparator for sorting file/folder names —
 * the `Array.prototype.sort` comparator shape, so callers pass it (or a
 * `.localeCompare`-shaped wrapper) directly.
 *
 * Plain `localeCompare` treats digit runs character-by-character, so "Trip
 * 10" sorts before "Trip 2". `{ numeric: true }` compares embedded digit
 * runs by numeric value instead (Finder/Explorer-standard ordering), and
 * `{ sensitivity: 'base' }` ignores case and accent differences so casing
 * doesn't affect order. Mirrors Apple's `localizedStandardCompare` (#2398)
 * for cross-platform parity — see #2399.
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
