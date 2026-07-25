// Shape data for every icon in MapleIconComponent.
//
// Default rendering: stroked outline, fill=none, color from the component's
// `color` input, stroke-width from `strokeWidth` (or the shape's own
// `strokeWidth`, when it carries one). A shape with `filled: true` is filled
// with the same color and gets no stroke. `opacity` applies as-is to the SVG
// primitive (sidebar/inspector use 0.3 for the filled panel hint).
//
// The 23 editor tool glyphs live in their own table — `tool-glyph-shapes.ts` —
// because they are drawn to a stricter contract than the chrome set (#640).

import { circle, path, rect, sharpRect, type IconShape } from './icon-shape';
import { TOOL_ICON_SHAPES, type ToolIconName } from './tool-glyph-shapes';

export type { IconShape } from './icon-shape';
export type { ToolIconName } from './tool-glyph-shapes';

export type MapleIconName =
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'folder'
  | 'folder-open'
  | 'photos'
  | 'heart'
  | 'check'
  | 'x'
  | 'plus'
  | 'search'
  | 'star'
  | 'star-filled'
  | 'flag'
  | 'dot'
  | 'sort'
  | 'filter'
  | 'grid-sm'
  | 'grid-lg'
  | 'info'
  | 'droplet'
  | 'tag'
  | 'scope'
  | 'back'
  | 'zoom-in'
  | 'zoom-out'
  | 'split'
  | 'export'
  | 'edit'
  | 'eyedrop'
  | 'map-pin'
  | 'camera'
  | 'history'
  | 'copy'
  | 'paste'
  | 'revert'
  | 'sidebar'
  | 'inspector'
  | 'filmstrip'
  // --- Added in S0c (responsive program; spec §4). ---
  | 'ellipsis-horizontal'
  | 'share-up-square'
  | 'undo-uturn'
  | 'redo-uturn'
  | 'clear-circle-fill'
  | 'smart-source-wand'
  | 'album-stack'
  | 'keyword-hash'
  | 'person-circle'
  // --- Tool glyphs (S5 Editor). Final artwork in `tool-glyph-shapes.ts`. ---
  | ToolIconName;

export const ICON_SHAPES: Record<MapleIconName, readonly IconShape[]> = {
  'chevron-right': [path('M6 3l5 5-5 5')],
  'chevron-left': [path('M10 3l-5 5 5 5')],
  'chevron-down': [path('M3 6l5 5 5-5')],
  folder: [path('M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z')],
  'folder-open': [
    path('M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v.5H2.5L2 12a1 1 0 001 1h10l1-5.5'),
  ],
  photos: [rect(2.5, 3.5, 11, 9, 1.5), circle(6, 7, 1), path('M13 10l-3-3-5 5')],
  heart: [path('M8 13s-5-2.8-5-6.3A2.7 2.7 0 018 5a2.7 2.7 0 015 1.7C13 10.2 8 13 8 13z')],
  check: [path('M3 8l3.5 3.5L13 5')],
  x: [path('M4 4l8 8M12 4l-8 8')],
  plus: [path('M8 3v10M3 8h10')],
  search: [circle(7, 7, 4), path('M10 10l3 3')],
  star: [path('M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z')],
  'star-filled': [
    {
      kind: 'path',
      d: 'M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z',
      filled: true,
    },
  ],
  flag: [path('M4 2v12M4 3h8l-2 2.5L12 8H4')],
  dot: [{ kind: 'circle', cx: 8, cy: 8, r: 2.5, filled: true }],
  sort: [path('M4 4l2-2 2 2M6 2v10M12 12l-2 2-2-2M10 14V4')],
  filter: [path('M2.5 3.5h11l-4 5v4l-3 1.5V8.5l-4-5z')],
  'grid-sm': [
    sharpRect(2.5, 2.5, 3, 3),
    sharpRect(6.5, 2.5, 3, 3),
    sharpRect(10.5, 2.5, 3, 3),
    sharpRect(2.5, 6.5, 3, 3),
    sharpRect(6.5, 6.5, 3, 3),
    sharpRect(10.5, 6.5, 3, 3),
    sharpRect(2.5, 10.5, 3, 3),
    sharpRect(6.5, 10.5, 3, 3),
    sharpRect(10.5, 10.5, 3, 3),
  ],
  'grid-lg': [
    sharpRect(2.5, 2.5, 4.5, 4.5),
    sharpRect(9, 2.5, 4.5, 4.5),
    sharpRect(2.5, 9, 4.5, 4.5),
    sharpRect(9, 9, 4.5, 4.5),
  ],
  info: [circle(8, 8, 5.5), path('M8 7.5v3.5M8 5.5v.01')],
  droplet: [path('M8 2.5S3.5 7 3.5 10A4.5 4.5 0 008 14.5 4.5 4.5 0 0012.5 10C12.5 7 8 2.5 8 2.5z')],
  tag: [path('M2.5 8.5l6 6 6-6V2.5h-6l-6 6z'), circle(10, 6, 1)],
  scope: [path('M2 13h2l1-4 1 6 1-8 1 10 1-7 1 5 1-3 1 2h3')],
  back: [path('M10 3L5 8l5 5M5 8h9')],
  'zoom-in': [circle(7, 7, 4), path('M10 10l3 3M7 5v4M5 7h4')],
  'zoom-out': [circle(7, 7, 4), path('M10 10l3 3M5 7h4')],
  split: [rect(2.5, 3.5, 11, 9, 1), path('M8 3.5v9')],
  export: [path('M8 2.5v8M5 5.5l3-3 3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2')],
  // Pencil — reuses the proven glyph from `SettingsIconName`'s 'edit' case
  // (projects/maple/src/app/settings/settings-icon.component.ts) so the two
  // icon systems draw the same pencil rather than diverging designs. Used
  // for "open this photo in the editor" affordances (Preview bottom bar's
  // Edit button, #Web Preview Surface Task 4).
  edit: [path('M3 13l1-3 7-7 2 2-7 7-3 1zM10 4l2 2')],
  eyedrop: [
    path('M11 2.5l2.5 2.5-1.5 1.5L10.5 5l-5.5 5.5L3 12l-.5 1.5 1.5-.5 1.5-1.5L11 6l-1-1 1.5-1.5z'),
  ],
  'map-pin': [
    path('M8 14s-4.5-4-4.5-7.5A4.5 4.5 0 018 2a4.5 4.5 0 014.5 4.5C12.5 10 8 14 8 14z'),
    circle(8, 6.5, 1.5),
  ],
  camera: [rect(2.5, 4.5, 11, 8, 1.5), circle(8, 8.5, 2.5), path('M6 4.5l1-1.5h2l1 1.5')],
  history: [
    path('M2.5 8a5.5 5.5 0 105.5-5.5c-1.8 0-3.4.9-4.4 2.3M2.5 2.5v2.5H5'),
    path('M8 5v3.2l2 1.3'),
  ],
  copy: [rect(5.5, 5.5, 8, 8, 1), path('M3.5 10.5v-7a1 1 0 011-1h7')],
  paste: [rect(3.5, 4.5, 9, 9, 1), path('M6 4.5V3h4v1.5M6 3h4')],
  revert: [path('M2.5 3v3.5H6'), path('M3 6.5A5.5 5.5 0 118 13.5')],
  sidebar: [
    rect(2, 3.5, 12, 9, 1.5),
    path('M6 3.5v9'),
    { kind: 'path', d: 'M2.5 4.5H5.5v7H2.5z', filled: true, opacity: 0.3 },
  ],
  inspector: [
    rect(2, 3.5, 12, 9, 1.5),
    path('M10 3.5v9'),
    { kind: 'path', d: 'M10.5 4.5H13.5v7H10.5z', filled: true, opacity: 0.3 },
  ],
  filmstrip: [rect(2.5, 2.5, 11, 11, 1), path('M4 4v8M12 4v8'), path('M4 7h1M4 9h1M11 7h1M11 9h1')],
  // --- S0c chrome glyphs (docs/spec/responsive-program-s0-icons.md) ---
  // Three filled dots — overflow / "more" menu trigger.
  'ellipsis-horizontal': [
    { kind: 'circle', cx: 4, cy: 8, r: 1, filled: true },
    { kind: 'circle', cx: 8, cy: 8, r: 1, filled: true },
    { kind: 'circle', cx: 12, cy: 8, r: 1, filled: true },
  ],
  // SF `square.and.arrow.up` analogue — up-arrow above an open tray.
  // Hand-rolled to read cleanly at 16px; visually distinct from `export`
  // which has a flat base bar (this one is a U-shaped tray).
  'share-up-square': [
    // Arrow shaft + head pointing up.
    path('M8 2v8M5 5l3-3 3 3'),
    // Open tray (U-shape) at the bottom.
    path('M3.5 9v3a1 1 0 001 1h7a1 1 0 001-1V9'),
  ],
  // U-turn arrow returning to the left (undo).
  'undo-uturn': [path('M2.5 6.5L5 4l2.5 2.5'), path('M5 4v4a3 3 0 003 3h5.5')],
  // Mirror of undo — U-turn returning to the right (redo).
  'redo-uturn': [path('M13.5 6.5L11 4 8.5 6.5'), path('M11 4v4a3 3 0 01-3 3H2.5')],
  // Filled disc with an X-shaped knockout — search-field clear button.
  // Single <path fill-rule="evenodd">: subpath 1 draws the disc (clockwise),
  // subpath 2 traces the X glyph outline as a 12-vertex pinwheel polygon.
  // evenodd subtracts the X interior from the disc so the cut-out reads as
  // the page background, not as `currentColor` over `currentColor` (which
  // would render as a solid disc — see PR #589 review thread).
  // The X is a 1.5-thick crossed-rectangle pair whose union is traced as
  // one closed polygon; tips are perpendicular (blunt) for a clean read at
  // 16px. Crotches sit at distance 0.75/sin(45°) ≈ 1.06 from center on the
  // cardinal axes; tip corners at ±0.53 offset along each axis from the
  // tip centerline.
  'clear-circle-fill': [
    {
      kind: 'path',
      d:
        // Outer disc — clockwise.
        'M2.5 8A5.5 5.5 0 1 0 13.5 8A5.5 5.5 0 1 0 2.5 8Z' +
        // X cutout — counterclockwise traversal of the X outline.
        'M8 6.94L9.97 4.97L11.03 6.03L9.06 8L11.03 9.97L9.97 11.03' +
        'L8 9.06L6.03 11.03L4.97 9.97L6.94 8L4.97 6.03L6.03 4.97Z',
      filled: true,
      fillRule: 'evenodd',
    },
  ],
  // Wand staff with a sparkle accent — "smart" / generated source.
  'smart-source-wand': [
    path('M3 13L11 5'),
    // Four-point sparkle at the tip.
    path('M13 2v2M12 3h2M14 5l-1 1M11 4l1 1'),
  ],
  // Three offset stacked rectangles — album / collection.
  'album-stack': [rect(4.5, 2.5, 9, 6, 1), rect(3, 5, 10, 6, 1), rect(2, 7.5, 12, 6, 1)],
  // Hash glyph — keyword / tag.
  'keyword-hash': [path('M6 2.5l-1 11M11 2.5l-1 11M3 6h10M3 10h10')],
  // Head circle + shoulder curve inside an outer face circle — person.
  'person-circle': [circle(8, 8, 5.5), circle(8, 6.5, 1.75), path('M4.5 12.5a3.5 3.5 0 017 0')],

  // ── S5 Editor tool glyphs (#640) ─────────────────────────────────────────
  // Final artwork, drawn as one family — see `tool-glyph-shapes.ts` for the
  // drawing contract and the per-glyph notes.
  ...TOOL_ICON_SHAPES,
};
