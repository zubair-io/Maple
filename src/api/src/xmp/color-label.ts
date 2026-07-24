/**
 * Canonical color-label vocabulary — single source of truth for the API
 * side (XMP parser/serializer, batch route, metadata snapshots, search
 * filter, schema docstrings).
 *
 * #1657: the XMP/batch path and the search filter had drifted onto two
 * different five-color subsets of this six-color set (`orange` was
 * writable but unfilterable; `purple` was filterable but unreachable
 * from the writers). Every consumer of the vocabulary must import it
 * from here rather than re-declaring its own literal union/set, so the
 * two directions can't drift apart again.
 *
 * Not codegen-sourced: `tools/codegen.sh` (driven by `raw-core`) targets
 * Swift + the web `maple-common` project only — it does not reach
 * `src/api`. The web side single-sources the same six colors from
 * `src/web/projects/maple-common/src/lib/models/color-label.ts`; keep
 * the two lists in sync by hand if the vocabulary ever changes again.
 */
export const COLOR_LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type ColorLabel = (typeof COLOR_LABELS)[number];

/** Set form for fast `.has()` membership checks against parsed strings. */
export const VALID_COLOR_LABELS: ReadonlySet<string> = new Set(COLOR_LABELS);
