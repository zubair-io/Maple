/** XMP wire vocabulary generated from raw-core; parsing remains case-sensitive. */
import { COLOR_LABEL_VALUES } from '../generated/color-labels.generated.ts';

export const COLOR_LABELS = COLOR_LABEL_VALUES;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/** Set form for fast `.has()` membership checks against parsed strings. */
export const VALID_COLOR_LABELS: ReadonlySet<string> = new Set(COLOR_LABELS);

/** Adobe's `xmp:Label` colour words (Lightroom/Bridge, case-sensitive) → Maple's vocabulary. */
const ADOBE_LABEL_COLORS: Readonly<Record<string, ColorLabel>> = {
  Red: 'red',
  Orange: 'orange',
  Yellow: 'yellow',
  Green: 'green',
  Blue: 'blue',
  Purple: 'purple',
};

/** `Object.hasOwn`, so an inherited key such as `toString` is never read as a colour. */
export function adobeLabelColor(word: string): ColorLabel | undefined {
  return Object.hasOwn(ADOBE_LABEL_COLORS, word) ? ADOBE_LABEL_COLORS[word] : undefined;
}
