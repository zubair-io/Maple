// Canonical color-label vocabulary (#1657 — single source of truth).
//
// Before this, the batch/XMP path (xmp-parser.service.ts, xmp.types.ts,
// batch-metadata panel) recognised only `red | orange | yellow | green |
// blue`, while search (search.service.ts, timeline-state.service.ts,
// search.vm.ts) recognised only `red | yellow | green | blue | purple`. A
// photo labeled `orange` via batch edit was silently unfilterable by
// search, and `purple` was filterable but unreachable from any UI control.
//
// The canonical vocabulary is the six-value union of both legacy sets:
// existing `orange` values written by prior batch edits stay valid and
// become filterable, `purple` becomes reachable from the batch UI, and
// sidecars written by Adobe tools (which use `purple`) continue to parse.
//
// Every module that validates or lists color labels imports this const
// rather than hard-coding its own literal set/union.

export const COLOR_LABEL_VALUES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type ColorLabelValue = (typeof COLOR_LABEL_VALUES)[number];

/** True iff `s` is one of the six canonical color-label values. */
export function isColorLabelValue(s: string): s is ColorLabelValue {
  return (COLOR_LABEL_VALUES as readonly string[]).includes(s);
}
