/**
 * Canonical color-label vocabulary (#1657 — single source of truth).
 *
 * Before this, the batch/XMP path (`metadata-parser.ts`, `metadata-input.ts`,
 * `metadata-snapshots.ts`, `xmp-batch.ts`, and the web batch UI) recognised
 * only `red | orange | yellow | green | blue`, while search
 * (`routes/search/query.ts`) recognised only `red | yellow | green | blue |
 * purple`. A photo labeled `orange` via batch edit was silently unfilterable
 * by search, and `purple` was filterable but unreachable from any UI control.
 *
 * The canonical vocabulary is the six-value union of both legacy sets:
 * existing `orange` values written by prior batch edits stay valid and
 * become filterable, `purple` becomes reachable from the batch UI, and
 * sidecars written by Adobe tools (which use `purple`) continue to parse.
 *
 * Every module that validates or lists color labels imports this const
 * rather than hard-coding its own literal set/union — see the drift-guard
 * test in `metadata-parser.test.ts` (or the sibling test covering this
 * module) for the invariant this protects.
 */
export const COLOR_LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type ColorLabel = (typeof COLOR_LABELS)[number];

/** Set form for O(1) membership checks (parsing, query validation). */
export const COLOR_LABEL_SET: ReadonlySet<string> = new Set(COLOR_LABELS);

/** True iff `s` is one of the six canonical color-label values. */
export function isColorLabel(s: string): s is ColorLabel {
  return COLOR_LABEL_SET.has(s);
}
