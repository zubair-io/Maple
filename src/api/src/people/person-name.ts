/**
 * The one rule for a person's display name, shared by the repo (which
 * throws, as an invariant guard) and the routes (which turn it into a
 * 400).
 *
 * Commas are rejected because search's `people` filter param is
 * comma-separated on the wire (`GET /api/search?people=A,B`, mirrored by
 * the Meilisearch `people` attribute and Apple's `SearchParams`). A name
 * containing a comma would split into two names that resolve to nobody,
 * and since unresolved names match NOTHING the filter would silently
 * return zero results (#2877). Constraining the name keeps one separator
 * working across all three surfaces instead of re-encoding the param in
 * each of them.
 */

/** Validation message for `name`, or `null` when it is acceptable. The
 * routes use this to answer 400 before touching the repo. */
export function personNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'name must not be empty';
  if (trimmed.includes(',')) return 'name must not contain a comma';
  return null;
}

/** Trim + validate in one step, throwing on a bad name. The repo's
 * invariant guard behind the routes' 400 — returns the trimmed name so
 * callers don't trim twice. */
export function assertValidPersonName(name: string): string {
  const trimmed = name.trim();
  const invalid = personNameError(trimmed);
  if (invalid) throw new Error(invalid);
  return trimmed;
}
