// Shape data for every icon in MapleIconComponent.
//
// Default rendering: stroked outline, fill=none, color from the component's
// `color` input, stroke-width from `strokeWidth`. A shape with `filled: true`
// is filled with the same color and gets no stroke. `opacity` applies as-is
// to the SVG primitive (sidebar/inspector use 0.3 for the filled panel hint).

export type MapleIconName =
    | 'chevron-right'
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
    | 'eyedrop'
    | 'map-pin'
    | 'camera'
    | 'history'
    | 'copy'
    | 'paste'
    | 'revert'
    | 'sidebar'
    | 'inspector'
    | 'filmstrip';

interface ShapeBase {
    filled?: boolean;
    opacity?: number;
    /** Skip stroke-linecap/linejoin="round" so the shape renders with the
     * SVG defaults (butt cap, miter join). Used by the grid icons whose
     * 90° corners must stay sharp; rounded joins would visibly bevel the
     * 3×3 / 4.5×4.5 cells. */
    sharp?: boolean;
}

export type IconShape =
    | (ShapeBase & { kind: 'path'; d: string })
    | (ShapeBase & {
          kind: 'rect';
          x: number;
          y: number;
          width: number;
          height: number;
          rx?: number;
      })
    | (ShapeBase & { kind: 'circle'; cx: number; cy: number; r: number });

const rect = (
    x: number,
    y: number,
    width: number,
    height: number,
    rx?: number,
): IconShape => ({ kind: 'rect', x, y, width, height, ...(rx !== undefined ? { rx } : {}) });

const sharpRect = (x: number, y: number, width: number, height: number): IconShape => ({
    kind: 'rect',
    x,
    y,
    width,
    height,
    sharp: true,
});

const path = (d: string): IconShape => ({ kind: 'path', d });
const circle = (cx: number, cy: number, r: number): IconShape => ({ kind: 'circle', cx, cy, r });

export const ICON_SHAPES: Record<MapleIconName, readonly IconShape[]> = {
    'chevron-right': [path('M6 3l5 5-5 5')],
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
    eyedrop: [
        path('M11 2.5l2.5 2.5-1.5 1.5L10.5 5l-5.5 5.5L3 12l-.5 1.5 1.5-.5 1.5-1.5L11 6l-1-1 1.5-1.5z'),
    ],
    'map-pin': [
        path('M8 14s-4.5-4-4.5-7.5A4.5 4.5 0 018 2a4.5 4.5 0 014.5 4.5C12.5 10 8 14 8 14z'),
        circle(8, 6.5, 1.5),
    ],
    camera: [
        rect(2.5, 4.5, 11, 8, 1.5),
        circle(8, 8.5, 2.5),
        path('M6 4.5l1-1.5h2l1 1.5'),
    ],
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
    filmstrip: [
        rect(2.5, 2.5, 11, 11, 1),
        path('M4 4v8M12 4v8'),
        path('M4 7h1M4 9h1M11 7h1M11 9h1'),
    ],
};
