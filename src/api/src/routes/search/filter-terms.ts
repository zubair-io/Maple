/**
 * Wire-term parsing for the unified-search structured filters (#2864):
 * the `people` and `place` params, and the place-label ↔ Mongo-clause
 * round-trip. Split out of `query.ts` to keep that file inside the
 * file-size budget (CONTRIBUTING.md § "File-size budget") — same move as
 * the #2129 `query-schema.ts` split; `query.ts` re-exports these names so
 * importers are unaffected.
 */

/** Person names from the comma-separated `people` param, trimmed and
 * de-blanked. Shared by the Meilisearch branch (which filters on the
 * `people` attribute directly) and the routes, which resolve the names to
 * person ids (`personIdsForNames`) for `buildFilter`'s Mongo clause. */
export function peopleNames(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Place labels from the `|`-separated `place` param (labels contain
 * commas, so commas can't separate entries). */
export function parsePlaceLabels(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** A rollup half the facets pipeline treats as blank: absent, `null`, or
 * `''`. The clause below must accept the same set, or a facet label built
 * from an `''`-half tuple would count assets its own filter then drops. */
const BLANK_HALF = { $in: [null, ''] };

/** Mongo clause for one place label, inverting the label rule the facets
 * endpoint uses (`placeLabel` in `facets.ts`): "locality, region" splits on
 * the LAST ", " back into the exact rollup tuple; a bare label is either a
 * locality with a blank region or a region with a blank locality, so it
 * matches both. */
export function placeLabelClause(label: string): Record<string, unknown> {
  const idx = label.lastIndexOf(', ');
  if (idx > 0) {
    return {
      'place.rollups.locality': label.slice(0, idx),
      'place.rollups.region': label.slice(idx + 2),
    };
  }
  return {
    $or: [
      { 'place.rollups.locality': label, 'place.rollups.region': BLANK_HALF },
      { 'place.rollups.locality': BLANK_HALF, 'place.rollups.region': label },
    ],
  };
}
