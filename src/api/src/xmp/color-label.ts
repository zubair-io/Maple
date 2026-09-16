/** XMP wire vocabulary generated from raw-core; parsing remains case-sensitive. */
import { COLOR_LABEL_VALUES } from '../generated/color-labels.generated.ts';

export const COLOR_LABELS = COLOR_LABEL_VALUES;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/** Set form for fast `.has()` membership checks against parsed strings. */
export const VALID_COLOR_LABELS: ReadonlySet<string> = new Set(COLOR_LABELS);
