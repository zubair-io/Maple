// Editor tool glyphs — the 22 (now 23, with Brightness from #1108) drawings
// behind the S5 editor's tool pill row and tool dock. Final artwork for #640;
// replaces the v0.1 placeholders that shipped with S5c (#625).
//
// Drawing contract (#640, docs/design/responsive-program/s5-editor.md):
//   • 16×16 viewBox, ~1.8 units of padding so round caps never clip.
//   • 1.6 stroke, round caps and joins, monochromatic and stroke-only —
//     no filled shapes, no two-tone opacity hints.
//   • Colour always comes from the renderer's `currentColor`.
//
// The set is drawn as a family, not as 23 individual icons. Shared motifs:
//   • Disc (r 4.8, centred) — the Light group's tonal-band tools.
//   • Sun (core circle + radial rays) — Exposure / Brightness / Highlights.
//   • Droplet — Vibrance / Saturation, with fill-level chords for "how much".
//   • Rounded frame (10.8 square, rx 2.8) — the image-wide Effects tools.
//   • Round-cap dot (`v0.01`, renders as a 1.6 disc) — grain, split tones,
//     chroma speckles.
//
// Apple draws the same path data from `src/apple/Maple/Views/ToolGlyphShapes.swift`;
// the two tables are kept in sync by hand and any edit here must be mirrored
// there so a tool looks identical on macOS and web.

import { type IconShape } from './icon-shape';

export type ToolIconName =
  | 'tool-exposure'
  | 'tool-brightness'
  | 'tool-contrast'
  | 'tool-highlights'
  | 'tool-shadows'
  | 'tool-whites'
  | 'tool-blacks'
  | 'tool-temp'
  | 'tool-tint'
  | 'tool-vibrance'
  | 'tool-saturation'
  | 'tool-hsl'
  | 'tool-clarity'
  | 'tool-texture'
  | 'tool-dehaze'
  | 'tool-vignette'
  | 'tool-grain'
  | 'tool-split-tone'
  | 'tool-sharpen'
  | 'tool-noise'
  | 'tool-color-nr'
  | 'tool-crop'
  | 'tool-presets';

/** Stroke weight every tool glyph is drawn to (#640). */
export const TOOL_GLYPH_STROKE_WIDTH = 1.6;

const p = (d: string): IconShape => ({
  kind: 'path',
  d,
  strokeWidth: TOOL_GLYPH_STROKE_WIDTH,
});

const c = (cx: number, cy: number, r: number): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r,
  strokeWidth: TOOL_GLYPH_STROKE_WIDTH,
});

const r = (x: number, y: number, width: number, height: number, rx: number): IconShape => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
  rx,
  strokeWidth: TOOL_GLYPH_STROKE_WIDTH,
});

/** A round-cap dot of exactly one stroke-width across. The 0.01 tail keeps
 * every renderer honest — a truly zero-length subpath is allowed to vanish. */
const dot = (x: number, y: number): IconShape => p(`M${x} ${y}v0.01`);

/** Teardrop outline: apex at (8,2.8) over a circle of r 3.7 at (8,9.6). */
const DROPLET =
  'M8 2.8C6 5.2 4.3 7.4 4.3 9.6C4.3 11.64 5.96 13.3 8 13.3' +
  'C10.04 13.3 11.7 11.64 11.7 9.6C11.7 7.4 10 5.2 8 2.8Z';

/** Rounded frame shared by the image-wide Effects glyphs. */
const FRAME = r(2.6, 2.6, 10.8, 10.8, 2.8);

export const TOOL_ICON_SHAPES: Record<ToolIconName, readonly IconShape[]> = {
  // ── Light ───────────────────────────────────────────────────────────────
  // Full sun: small core, eight rays between r 4.5 and r 5.8. The brightest,
  // busiest glyph in the set — Exposure is the group's headline control.
  'tool-exposure': [
    c(8, 8, 2.3),
    p(
      'M8 2.2v1.3M8 13.8v-1.3M2.2 8h1.3M13.8 8h-1.3' +
        'M3.9 3.9l0.92 0.92M12.1 3.9l-0.92 0.92' +
        'M3.9 12.1l0.92-0.92M12.1 12.1l-0.92-0.92',
    ),
  ],
  // Quieter sibling of Exposure: the same core with four rays instead of
  // eight. Midtone-band gain (#1108) is the gentler move and the glyph says
  // so by being the sparser sun.
  'tool-brightness': [c(8, 8, 2.2), p('M8 2.2v1.5M8 13.8v-1.5M2.2 8h1.5M13.8 8h-1.5')],
  // Disc split down the middle — the two halves of the tonal range pulling
  // apart. Shares the Light group's r-4.8 disc with Whites and Blacks.
  'tool-contrast': [c(8, 8, 4.8), p('M8 3.2v9.6')],
  // Sun clearing a horizon: the brightest band of the frame. Rays sit left,
  // right and on both upper diagonals so the disc reads as rising.
  'tool-highlights': [
    c(8, 6.6, 2.4),
    p('M4.32 2.92l0.71 0.71M11.68 2.92l-0.71 0.71M2.8 6.6h1M13.2 6.6h-1'),
    p('M2.4 12.4h11.2'),
  ],
  // Crescent — the dark band. Outer arc r 5.2 about (8,8); the bite is an
  // r-5.37 arc centred at (12.32,8), which leaves an even crescent waist.
  'tool-shadows': [
    p(
      'M9.95 3.18C7.78 2.3 5.29 2.98 3.87 4.85C2.44 6.71 2.44 9.29 3.87 11.15' +
        'C5.29 13.02 7.78 13.7 9.95 12.82C8.11 11.92 6.95 10.05 6.95 8' +
        'C6.95 5.95 8.11 4.08 9.95 3.18Z',
    ),
  ],
  // Disc with a chevron riding up — pushing the white point higher.
  'tool-whites': [c(8, 8, 4.8), p('M5.8 9L8 6.8l2.2 2.2')],
  // Mirror of Whites: chevron dropping — pushing the black point down.
  'tool-blacks': [c(8, 8, 4.8), p('M5.8 7L8 9.2l2.2-2.2')],

  // ── Color ───────────────────────────────────────────────────────────────
  // Thermometer: stem meets the bulb exactly, two scale ticks on the right.
  // The column sits left of centre so the ticks balance the glyph's mass.
  'tool-temp': [p('M7.2 3.4v6'), c(7.2, 11.3, 1.9), p('M9 4.8h1.4M9 7.2h1.4')],
  // Two overlapping discs — the green/magenta pair mixing across the axis.
  'tool-tint': [c(6.3, 8, 3.5), c(9.7, 8, 3.5)],
  // Droplet carrying one low fill chord: colour lifted a little, and only
  // where there is room for it.
  'tool-vibrance': [p(DROPLET), p('M6.6 10.8h2.8')],
  // Same droplet, filled higher — two chords read as the stronger, flatter
  // sibling of Vibrance.
  'tool-saturation': [p(DROPLET), p('M6.6 10.8h2.8'), p('M6.7 8.4h2.6')],
  // Three tracks with knobs at different offsets — hue, saturation and
  // luminance moving independently.
  'tool-hsl': [
    p('M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8'),
    c(5.6, 4.6, 1.4),
    c(10, 8, 1.4),
    c(7.2, 11.4, 1.4),
  ],

  // ── Effects ─────────────────────────────────────────────────────────────
  // Faceted diamond with a midline: local contrast snapping the midtones.
  'tool-clarity': [p('M8 2.8L13.2 8L8 13.2L2.8 8Z'), p('M5.8 8h4.4')],
  // Two out-of-phase waves — surface detail, not tone.
  'tool-texture': [
    p('M2.6 5.6c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0c1.2-3 2.4 3 3.6 0'),
    p('M2.6 11c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0c1.2 3 2.4-3 3.6 0'),
  ],
  // Four staggered bands of atmosphere lying across the frame.
  'tool-dehaze': [p('M5 3.8h8.4M2.6 6.6h10.8M2.6 9.4h8.8M5 12.2h8.4')],
  // Frame with a bright centre circle — the corners are what fall away.
  'tool-vignette': [FRAME, c(8, 8, 3.1)],
  // Frame speckled with dots — film grain across the whole image. The six
  // dots are deliberately off-lattice; an even quincunx reads as a die face.
  'tool-grain': [
    FRAME,
    dot(5.4, 5.6),
    dot(9.8, 4.9),
    dot(7.2, 7.8),
    dot(11.1, 8.4),
    dot(5.9, 10.6),
    dot(9.4, 11.2),
  ],
  // Frame cut in half with a tone marker in each band — one hue up top, a
  // different one below.
  'tool-split-tone': [FRAME, p('M2.6 8h10.8'), dot(8, 5.2), dot(8, 10.8)],

  // ── Detail ──────────────────────────────────────────────────────────────
  // A single sharp peak rising off a flat baseline — edge acutance.
  'tool-sharpen': [p('M2.6 12.2H5L8 4.2l3 8h2.4')],
  // A noisy run settling into a clean line — luminance noise reduction.
  'tool-noise': [p('M2.6 8.4L4.2 5.2L5.8 11.2L7.4 6.4L8.8 8.4H13.4')],
  // Noise's sibling: the same run settling into the same clean line, but the
  // disorder is discrete specks rather than a continuous jag — chroma noise.
  // The dots sit on Noise's own vertices so the pair reads as one idea.
  'tool-color-nr': [dot(2.8, 8.4), dot(4.4, 5.8), dot(6, 10.6), p('M7.8 8.4H13.4')],

  // ── Standalone ──────────────────────────────────────────────────────────
  // Two crop rails crossing — the classic corner-bracket pair.
  'tool-crop': [p('M4.6 2.6v8.8h8.8'), p('M2.6 4.6h8.8v8.8')],
  // Two offset cards — a stack of saved looks.
  'tool-presets': [r(5.2, 2.8, 8, 8, 2), r(2.8, 5.2, 8, 8, 2)],
};
