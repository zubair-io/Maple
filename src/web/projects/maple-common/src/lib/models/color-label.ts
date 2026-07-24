// Canonical color-label vocabulary — single source of truth for the web
// side (XMP parser/serializer, batch-metadata panel, timeline filter row,
// search page color filter).
//
// #1657: the XMP/batch path and the search/timeline filters had drifted
// onto two different five-color subsets of this six-color set (`orange`
// was writable but unfilterable; `purple` was filterable but unreachable
// from the writers). Every consumer of the vocabulary must import it from
// here rather than re-declaring its own literal union/array, so the two
// directions can't drift apart again.
//
// Not codegen-sourced: `tools/codegen.sh` (driven by `raw-core`) doesn't
// model color *labels* (a culling/organization concept, not a color-pipeline
// constant). The API side single-sources the same six colors independently
// from `src/api/src/xmp/color-label.ts`; keep the two lists in sync by hand
// if the vocabulary ever changes again.

export const COLOR_LABEL_VALUES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type ColorLabelValue = (typeof COLOR_LABEL_VALUES)[number];

/** Type guard — narrows an arbitrary string to `ColorLabelValue`. */
export function isColorLabelValue(value: string): value is ColorLabelValue {
  return (COLOR_LABEL_VALUES as readonly string[]).includes(value);
}

export interface ColorLabelOption {
  value: ColorLabelValue;
  label: string;
  swatch: string;
}

/** Display metadata (label + swatch hex) for each color, in canonical
 * order. Consumed by the timeline filter row and the batch-metadata
 * color `<select>` (both iterate this table directly). The search
 * page's `search.vm.ts` cannot value-import from maple-common (it is a
 * plain-TS module by design — see its file header), so it keeps a local
 * option table whose VALUE set is type-locked to `ColorLabelValue`;
 * only its display strings could drift. Callers that need a leading
 * "any color" option prepend their own `{ value: '', ... }` entry —
 * the wording for that entry differs per surface ("Any" vs "Any
 * color"). */
export const COLOR_LABEL_OPTIONS: ReadonlyArray<ColorLabelOption> = [
  { value: 'red', label: 'Red', swatch: '#e11d48' },
  { value: 'orange', label: 'Orange', swatch: '#f97316' },
  { value: 'yellow', label: 'Yellow', swatch: '#eab308' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'purple', label: 'Purple', swatch: '#a855f7' },
];
