import type { MuiScopeSample, MuiVectorscopeSample } from '@maple-common';

// Shared specimen helpers for the Organisms tier — small inline SVG
// data-URI photos/thumbnails and deterministic pseudo-scope data. No
// network dependency, same convention as TierAtomsComponent.specimenPhoto /
// TierMolecules2Component.specimenPhoto. Fictional sample content
// throughout this tier: this page is public, so no real names, emails, or
// asset paths ever appear here.

export const specimenPhoto =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'>" +
  "<rect width='160' height='120' fill='%23c4493a'/>" +
  "<circle cx='80' cy='46' r='20' fill='%23422016'/>" +
  "<rect x='36' y='78' width='88' height='30' rx='12' fill='%23422016'/></svg>";

export const specimenLandscape =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='120'>" +
  "<rect width='200' height='120' fill='%232f4538'/>" +
  "<circle cx='160' cy='30' r='16' fill='%23e8c468'/>" +
  "<path d='M0 90 L50 50 L90 80 L130 40 L200 90 L200 120 L0 120 Z' fill='%231c1917'/></svg>";

// Small inline SVG data-URI thumbnail generator, one per index, cycling a
// fixed palette. A photo/avatar in this tier is always a generated shape,
// never an external URL, a real filesystem path, or a real person's
// likeness.
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

export function thumb(seed: number): string {
  const color = THUMB_PALETTE[seed % THUMB_PALETTE.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    `<rect width='80' height='80' fill='%23${color}'/>` +
    "<circle cx='40' cy='32' r='14' fill='%23241f1c'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23241f1c'/></svg>"
  );
}

// Deterministic pseudo-scope data — a fixed sine/triangle mix per channel
// rather than `Math.random()`, so the specimen renders identically on every
// load instead of reshuffling on each page refresh.
function scopeCurve(bins: number, phase: number): readonly number[] {
  return Array.from({ length: bins }, (_, i) =>
    Math.max(0, Math.sin((i / bins) * Math.PI * 2 + phase) * 0.5 + 0.5),
  );
}

export function scopeSample(): MuiScopeSample {
  const histogram = {
    r: scopeCurve(32, 0),
    g: scopeCurve(32, 0.6),
    b: scopeCurve(32, 1.3),
  };
  const vectorscope: readonly MuiVectorscopeSample[] = Array.from({ length: 40 }, (_, i) => {
    const t = (i / 40) * Math.PI * 2;
    return {
      r: Math.max(0, Math.min(1, 0.5 + Math.cos(t) * 0.4)),
      g: Math.max(0, Math.min(1, 0.5 + Math.sin(t * 1.3) * 0.3)),
      b: Math.max(0, Math.min(1, 0.5 + Math.sin(t) * 0.4)),
    };
  });
  return {
    histogram,
    waveformLuma: scopeCurve(64, 0.3),
    parade: { r: scopeCurve(64, 0), g: scopeCurve(64, 0.6), b: scopeCurve(64, 1.3) },
    vectorscope,
  };
}
