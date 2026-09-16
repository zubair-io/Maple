// Wire values are generated from raw-core. UI wording and swatches stay here.
import { COLOR_LABEL_VALUES } from '../generated/color-labels.generated';
export { COLOR_LABEL_VALUES };

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
 * color `<select>` (both iterate this table directly). Callers that
 * need a leading "any color" option prepend their own `{ value: '',
 * ... }` entry — the wording for that entry differs per surface ("Any"
 * vs "Any color"). */
export const COLOR_LABEL_OPTIONS: ReadonlyArray<ColorLabelOption> = [
  { value: 'red', label: 'Red', swatch: '#e11d48' },
  { value: 'orange', label: 'Orange', swatch: '#f97316' },
  { value: 'yellow', label: 'Yellow', swatch: '#eab308' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'purple', label: 'Purple', swatch: '#a855f7' },
];
