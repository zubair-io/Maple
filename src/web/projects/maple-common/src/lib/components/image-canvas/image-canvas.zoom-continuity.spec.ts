// Continuity of a live gesture across a zoom it did not make (docs/zoom.md
// § Continuity, #5723): a zoom written outside the model (Z / F, the toolbar,
// a tool arming fit) or a shortcut pressed mid-press must not move the photo
// by anything but the pointer motion that follows. Runs the real
// `raw_wasm_canvas` module against a fake host.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal } from '@angular/core';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import * as rawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { CanvasZoomGestures, type ZoomGestureHost } from './image-canvas.zoom-gestures';
import { installCanvasZoomWasm } from './image-canvas.zoom-wasm';

beforeAll(() => {
  const output = rawWasm.initSync({
    module: readFileSync(
      resolve(
        process.cwd(),
        'projects/maple-common/src/lib/raw-pipeline/pkg/canvas/raw_wasm_canvas_bg.wasm',
      ),
    ),
  });
  installCanvasZoomWasm(rawWasm, output.memory);
});

describe('a live gesture across a zoom it did not make', () => {
  // 1000×726 CSS wrap at (0,0), dpr 2, 4000×2500 native: fit 0.5; at 100% the
  // photo is 2000×1250 CSS px, so the pan range is ±500 × ±262.
  const FIT = 0.5;
  let pixelScale: number;
  let pan: { x: number; y: number };
  let g: CanvasZoomGestures;
  const writes = signal(0);
  const touched = (): void => writes.update((n) => n + 1);

  /** A zoom written straight to the host, as `canvasSvc.zoomTo100()` / `fit()` do. */
  function writeOutsideTheModel(scale: number): void {
    pixelScale = scale;
    pan = { x: 0, y: 0 };
    touched();
  }

  function shortcut(key: '0' | '1'): void {
    g.onKeydown(new KeyboardEvent('keydown', { key, metaKey: true }), true);
  }

  beforeEach(() => {
    pixelScale = 0;
    pan = { x: 0, y: 0 };
    const host: ZoomGestureHost = {
      wrapSize: () => ({ w: 1000, h: 726 }),
      wrapRect: () =>
        ({ left: 0, top: 0, width: 1000, height: 726, right: 1000, bottom: 726 }) as DOMRect,
      nativeSize: () => ({ w: 4000, h: 2500 }),
      devicePixelRatio: () => 2,
      pixelScale: () => (writes(), pixelScale),
      pan: () => (writes(), pan),
      commitView: (ps, p) => {
        pixelScale = ps;
        pan = p;
        touched();
      },
      moveDivider: () => {},
    };
    g = new CanvasZoomGestures(host);
  });

  it('a held drag moves the photo by the new motion only after an outside 100%', () => {
    shortcut('1');
    g.onPointerDown({ pointerId: 1, clientX: 300, clientY: 300 });
    g.onPointerMove({ pointerId: 1, clientX: 400, clientY: 300 });
    expect(pan).toEqual({ x: 100, y: 0 });

    writeOutsideTheModel(1);
    g.onPointerMove({ pointerId: 1, clientX: 401, clientY: 300 });
    expect(pixelScale).toBe(1);
    expect(pan).toEqual({ x: 1, y: 0 });

    g.onPointerMove({ pointerId: 1, clientX: 431, clientY: 310 });
    expect(pan).toEqual({ x: 31, y: 10 });
  });

  it('a held pinch continues from its last magnification after an outside fit', () => {
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 363 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 363 });
    g.onPointerMove({ pointerId: 1, clientX: 300, clientY: 363 });
    g.onPointerMove({ pointerId: 2, clientX: 700, clientY: 363 });
    expect(pixelScale).toBeCloseTo(FIT * 2, 9);

    writeOutsideTheModel(0);
    g.onPointerMove({ pointerId: 2, clientX: 800, clientY: 363 });
    expect(pixelScale).toBeCloseTo(FIT * 1.25, 9);

    g.onPointerMove({ pointerId: 2, clientX: 900, clientY: 363 });
    expect(pixelScale).toBeCloseTo(FIT * 1.5, 9);
  });

  it('an outside zoom the model resolves differently does not hold a drag at its baseline', () => {
    shortcut('1');
    g.onPointerDown({ pointerId: 1, clientX: 300, clientY: 300 });
    g.onPointerMove({ pointerId: 1, clientX: 310, clientY: 300 });

    pixelScale = 1;
    pan = { x: 900, y: 0 };
    touched();
    g.onPointerMove({ pointerId: 1, clientX: 300, clientY: 300 });
    expect(pan).toEqual({ x: 490, y: 0 });
    g.onPointerMove({ pointerId: 1, clientX: 280, clientY: 300 });
    expect(pan).toEqual({ x: 470, y: 0 });
  });

  it('a press that began at fit pans from where the photo started to overflow', () => {
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    g.onPointerMove({ pointerId: 1, clientX: 200, clientY: 100 });
    expect(pan).toEqual({ x: 0, y: 0 });

    shortcut('1');
    g.onPointerMove({ pointerId: 1, clientX: 201, clientY: 100 });
    expect(pan).toEqual({ x: 1, y: 0 });
    g.onPointerMove({ pointerId: 1, clientX: 221, clientY: 105 });
    expect(pan).toEqual({ x: 21, y: 5 });
  });

  it('a pan interrupted by fit resumes from the pointer, not from its old baseline', () => {
    shortcut('1');
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    g.onPointerMove({ pointerId: 1, clientX: 150, clientY: 100 });
    expect(pan).toEqual({ x: 50, y: 0 });

    shortcut('0');
    g.onPointerMove({ pointerId: 1, clientX: 230, clientY: 100 });
    expect(pixelScale).toBe(0);

    shortcut('1');
    g.onPointerMove({ pointerId: 1, clientX: 231, clientY: 100 });
    expect(pan).toEqual({ x: 1, y: 0 });
  });
});
