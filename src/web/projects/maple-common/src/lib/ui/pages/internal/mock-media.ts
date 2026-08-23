// Shared inline-SVG placeholder art for the Wave W7 Page specimens
// (unified-component-catalog.md §6). Every Page composes several
// photo-bearing organisms (Collection Grid, Timeline, Preview Surface, …),
// so this lives once here instead of being copy-pasted per page component —
// the same "generated shape, never a real photo" convention as
// TierAtomsComponent.specimenPhoto / TierMolecules2Component.specimenPhoto
// in maple-syrup, just centralized across the 15 pages that need it rather
// than duplicated in each.

const THUMB_PALETTE = [
  'c4493a',
  '4a7a8c',
  '8c6a4a',
  '5a8c4a',
  '8c4a7a',
  '4a5a8c',
  'a8763a',
  '3a8c78',
] as const;

/** Deterministic 80×80 square thumbnail — grid cells, filmstrip frames,
 * timeline items, kanban card art. */
export function pageThumb(seed: number): string {
  const color = THUMB_PALETTE[seed % THUMB_PALETTE.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    `<rect width='80' height='80' fill='%23${color}'/>` +
    "<circle cx='40' cy='32' r='14' fill='%23241f1c'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23241f1c'/></svg>"
  );
}

/** Deterministic 240×160 landscape frame — canvas/preview-surface specimens
 * that need a wider aspect than the square thumbnail. */
export function pageLandscape(seed: number): string {
  const color = THUMB_PALETTE[seed % THUMB_PALETTE.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'>" +
    `<rect width='240' height='160' fill='%23${color}'/>` +
    "<circle cx='190' cy='40' r='20' fill='%23e8c468'/>" +
    "<path d='M0 120 L60 66 L108 106 L156 54 L240 120 L240 160 L0 160 Z' fill='%23241f1c'/></svg>"
  );
}
