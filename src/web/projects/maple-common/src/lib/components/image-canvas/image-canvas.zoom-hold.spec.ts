// The canvas holds at fit while an overlay that draws at the fit footprint
// (crop, mask, heal) is active (#5743): every user zoom and pan path is inert,
// the browser's own page zoom stays swallowed over the canvas, and programmatic
// fit and reclamp keep working. Runs the real `raw_wasm_canvas` module.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import * as rawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { ImageCanvasService, type FitFootprintOverlay } from './image-canvas.service';
import { CanvasZoomGestures } from './image-canvas.zoom-gestures';
import { ImageCanvasZoomHost } from './image-canvas.zoom-host';
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

const OVERLAYS: readonly FitFootprintOverlay[] = ['crop', 'mask', 'heal'];

describe('canvas zoom hold while a fit-footprint overlay is active (#5743)', () => {
  const wrap = signal({ w: 1000, h: 726 });
  let svc: ImageCanvasService;
  let g: CanvasZoomGestures;

  beforeEach(() => {
    wrap.set({ w: 1000, h: 726 });
    svc = new ImageCanvasService();
    g = new CanvasZoomGestures({
      wrapSize: () => wrap(),
      wrapRect: () =>
        ({
          left: 0,
          top: 0,
          width: wrap().w,
          height: wrap().h,
          right: wrap().w,
          bottom: wrap().h,
        }) as DOMRect,
      nativeSize: () => ({ w: 4000, h: 2500 }),
      devicePixelRatio: () => 2,
      pixelScale: () => svc.pixelScale(),
      pan: () => svc.pan(),
      holdsAtFit: () => svc.holdsAtFit(),
      pointerOwnedByEdit: (id) => svc.isEditOwnedPointer(id),
      commitView: (pixelScale, pan) => {
        svc.pixelScale.set(pixelScale);
        svc.pan.set(pan);
      },
      moveDivider: () => {},
    });
  });

  function pinchOut(): void {
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 363 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 363 });
    g.onPointerMove({ pointerId: 1, clientX: 300, clientY: 363 });
    g.onPointerMove({ pointerId: 2, clientX: 700, clientY: 363 });
    g.onPointerUp({ pointerId: 1, clientX: 300, clientY: 363 });
    g.onPointerUp({ pointerId: 2, clientX: 700, clientY: 363 });
  }

  const wheel = {
    ctrlKey: true,
    metaKey: false,
    deltaX: 0,
    deltaY: -100,
    clientX: 500,
    clientY: 363,
  };
  const chord = (key: string) =>
    new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });

  const userZoomPaths: ReadonlyArray<readonly [string, () => unknown]> = [
    ['pinch', () => pinchOut()],
    ['ctrl+wheel', () => g.onWheel(wheel)],
    ['double-click', () => g.onDoubleClick(500, 363)],
    ['badge', () => g.advanceStop()],
    ['step zoom', () => g.stepZoom(1)],
    ['Cmd+1', () => g.onKeydown(chord('1'), true)],
    ['the 100% control', () => svc.zoomTo100()],
  ];

  describe('with no overlay active', () => {
    it.each(userZoomPaths)('%s still zooms', (_name, act) => {
      act();
      expect(svc.pixelScale()).toBeGreaterThan(0);
    });
  });

  describe.each(OVERLAYS)('with the %s overlay active', (overlay) => {
    beforeEach(() => svc.setFitFootprintOverlay(overlay, true));

    it.each(userZoomPaths)('%s leaves the canvas at fit with zero pan', (_name, act) => {
      act();
      expect(svc.pixelScale()).toBe(0);
      expect(svc.pan()).toEqual({ x: 0, y: 0 });
    });

    it('still swallows the zoom chord so the browser does not page-zoom mid-edit', () => {
      const keys = [chord('1'), chord('0')];
      keys.forEach((e) => g.onKeydown(e, true));
      expect([g.onWheel(wheel), ...keys.map((e) => e.defaultPrevented)]).toEqual([
        true,
        true,
        true,
      ]);
    });

    it('leaves a plain wheel to the armed tool', () => {
      expect(g.onWheel({ ...wheel, ctrlKey: false, deltaY: 50 })).toBe(false);
    });

    it('releasing the overlay re-enables zooming and leaves the canvas at fit', () => {
      pinchOut();
      svc.setFitFootprintOverlay(overlay, false);
      expect(svc.pixelScale()).toBe(0);
      g.stepZoom(1);
      expect(svc.pixelScale()).toBeGreaterThan(0);
    });

    it('a window resize still reclamps against the new viewport', () => {
      svc.setFitFootprintOverlay(overlay, false);
      svc.pixelScale.set(1);
      svc.pan.set({ x: 1500, y: 0 });
      svc.setFitFootprintOverlay(overlay, true);
      wrap.set({ w: 1600, h: 900 });
      g.reclamp();
      expect(svc.pan().x).toBeLessThan(1500);
    });

    it('programmatic fit still works', () => {
      svc.setFitFootprintOverlay(overlay, false);
      g.stepZoom(1);
      svc.setFitFootprintOverlay(overlay, true);
      svc.zoomToFit();
      expect(svc.pixelScale()).toBe(0);
    });
  });

  it('holds until the last overlay lets go', () => {
    svc.setFitFootprintOverlay('crop', true);
    svc.setFitFootprintOverlay('mask', true);
    svc.setFitFootprintOverlay('crop', false);
    expect(svc.holdsAtFit()).toBe(true);
    svc.setFitFootprintOverlay('mask', false);
    expect(svc.holdsAtFit()).toBe(false);
  });
});

describe('a gesture in flight when the hold starts (#5743)', () => {
  let svc: ImageCanvasService;
  let g: CanvasZoomGestures;

  beforeEach(() => {
    svc = new ImageCanvasService();
    const wrapEl = document.createElement('div');
    wrapEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 726 }) as DOMRect;
    g = TestBed.runInInjectionContext(
      () =>
        new ImageCanvasZoomHost({
          canvasSvc: svc,
          state: { focusedAsset: () => null },
          wrapRef: new ElementRef(wrapEl),
          wrapW: signal(1000),
          wrapH: signal(726),
          imageExtent: signal({ w: 4000, h: 2500 }),
        } as never),
    ).gestures;
    g.stepZoom(1);
    TestBed.tick();
  });

  function holdThenRelease(): void {
    svc.setFitFootprintOverlay('crop', true);
    TestBed.tick();
    svc.zoomToFit();
    g.onPointerUp({ pointerId: 1, clientX: 0, clientY: 363 });
    g.onPointerUp({ pointerId: 2, clientX: 0, clientY: 363 });
    svc.setFitFootprintOverlay('crop', false);
    TestBed.tick();
    svc.pixelScale.set(1);
    svc.pan.set({ x: 0, y: 0 });
  }

  it('a pinch cut off by the hold does not leak its start scale into the next pinch', () => {
    svc.pixelScale.set(1);
    svc.pan.set({ x: 0, y: 0 });
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 363 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 363 });
    g.onPointerMove({ pointerId: 1, clientX: 380, clientY: 363 });
    holdThenRelease();
    g.onPointerDown({ pointerId: 3, clientX: 400, clientY: 363 });
    g.onPointerDown({ pointerId: 4, clientX: 600, clientY: 363 });
    g.onPointerMove({ pointerId: 4, clientX: 620, clientY: 363 });
    expect(svc.pixelScale()).toBeGreaterThan(1);
    expect(svc.pixelScale()).toBeLessThan(1.2);
  });

  it('a drag cut off by the hold does not leak its origin into the next drag', () => {
    svc.pixelScale.set(1);
    svc.pan.set({ x: 0, y: 0 });
    g.onPointerDown({ pointerId: 1, clientX: 500, clientY: 363 });
    g.onPointerMove({ pointerId: 1, clientX: 560, clientY: 363 });
    expect(svc.pan().x).toBe(60);
    holdThenRelease();
    g.onPointerDown({ pointerId: 3, clientX: 500, clientY: 363 });
    g.onPointerMove({ pointerId: 3, clientX: 510, clientY: 363 });
    expect(svc.pan().x).toBe(10);
  });
});
