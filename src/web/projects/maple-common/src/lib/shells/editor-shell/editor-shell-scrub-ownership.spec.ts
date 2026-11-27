// A pointer keeps the surface that took it at pointer-down until it is released
// (#5816, from #5745): a scrub started at fit never pans once the zoom changes,
// and a pan never turns into a scrub. Real gesture controller, real canvas
// service and the real zoom module; the shell is a fake.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal } from '@angular/core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { CanvasZoomGestures } from '../../components/image-canvas/image-canvas.zoom-gestures';
import { installCanvasZoomWasm } from '../../components/image-canvas/image-canvas.zoom-wasm';
import * as rawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { newScrubGestureState, onCanvasPointerDown } from './editor-shell-scrub';
import type { EditorShellComponent } from './editor-shell.component';

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

const WRAP = { w: 1000, h: 726 };
const Y = 363;

describe('a pointer keeps the surface that took it', () => {
  let svc: ImageCanvasService;
  let g: CanvasZoomGestures;
  let scrub: ReturnType<typeof newScrubGestureState>;
  let shell: EditorShellComponent;
  let wrapEl: HTMLElement;
  let armed: ReturnType<typeof signal<number>>;
  let setArmed: ReturnType<typeof vi.fn>;
  let editor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    svc = new ImageCanvasService();
    g = new CanvasZoomGestures({
      wrapSize: () => WRAP,
      wrapRect: () => ({ left: 0, top: 0, width: WRAP.w, height: WRAP.h }) as DOMRect,
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
    scrub = newScrubGestureState();
    armed = signal(0);
    setArmed = vi.fn((v: number) => armed.set(v));
    editor = {
      commit: vi.fn(),
      beginGesture: vi.fn(),
      endGesture: vi.fn(),
      cancelGesture: vi.fn(),
      cancelEdit: vi.fn(),
    };
    wrapEl = document.createElement('div');
    Object.defineProperty(wrapEl, 'clientWidth', { value: WRAP.w });
    shell = {
      canvasSvc: svc,
      canvasWrapRef: { nativeElement: wrapEl },
      editorState: {
        ...editor,
        library: { updateAdjustment: vi.fn() },
        imageId: () => 'a',
        currentAdjustment: () => ({}),
        armedToolAcceptsValueEdits: () => true,
        armedInternalValue: () => armed(),
        setArmedInternalValue: setArmed,
      },
      scrubbing: { set: vi.fn() },
      chromeState: { set: vi.fn() },
      hudVisible: { set: vi.fn() },
      showHud: vi.fn(),
      scheduleHudFade: vi.fn(),
      restartRecedeTimer: vi.fn(),
    } as unknown as EditorShellComponent;
    syncRouting();
  });

  function syncRouting(): void {
    svc.pointerEditsAtZoom.set(g.pointerEditsAtZoom());
  }

  function zoomTo(pixelScale: number): void {
    svc.pixelScale.set(pixelScale);
    svc.pan.set({ x: 0, y: 0 });
    syncRouting();
  }

  function pointerEvent(type: string, id: number, x: number, primary = true): PointerEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    Object.defineProperty(event, 'target', { value: wrapEl });
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'isPrimary', { value: primary });
    return event as PointerEvent;
  }

  function press(id: number, x: number, primary = true, pointerType?: string): void {
    g.onPointerDown({ pointerId: id, clientX: x, clientY: Y, isPrimary: primary, pointerType });
    onCanvasPointerDown(shell, scrub, pointerEvent('pointerdown', id, x, primary));
  }

  function move(id: number, x: number): void {
    g.onPointerMove({ pointerId: id, clientX: x, clientY: Y });
    window.dispatchEvent(pointerEvent('pointermove', id, x));
  }

  function release(id: number, x: number): void {
    g.onPointerUp({ pointerId: id, clientX: x, clientY: Y });
    window.dispatchEvent(pointerEvent('pointerup', id, x));
  }

  const view = () => ({ pixelScale: svc.pixelScale(), pan: svc.pan() });
  const wheelZoom = {
    ctrlKey: true,
    metaKey: false,
    deltaX: 0,
    deltaY: -100,
    clientX: 500,
    clientY: Y,
  };

  const zoomChanges: ReadonlyArray<readonly [string, () => void]> = [
    ['zoom to 100%', () => svc.zoomTo100()],
    ['step zoom in', () => g.stepZoom(1)],
    ['the zoom badge', () => g.advanceStop()],
    ['double-click', () => g.onDoubleClick(500, Y)],
    ['ctrl+wheel', () => g.onWheel(wheelZoom)],
  ];

  describe('a scrub started at fit', () => {
    it.each(zoomChanges)('keeps scrubbing and never pans after %s', (_name, change) => {
      press(1, 500);
      move(1, 540);
      change();
      syncRouting();
      expect(svc.pixelScale()).toBeGreaterThan(0);
      const zoomed = view();
      setArmed.mockClear();

      move(1, 600);
      move(1, 650);

      expect(setArmed).toHaveBeenCalledTimes(2);
      expect(armed()).toBeCloseTo(7.5, 9);
      expect(view()).toEqual(zoomed);
    });

    it('lets the next drag at 100% pan, and does not scrub it', () => {
      press(1, 500);
      move(1, 540);
      svc.zoomTo100();
      syncRouting();
      move(1, 600);
      release(1, 600);
      expect(editor['endGesture']).toHaveBeenCalledOnce();
      expect(svc.isEditOwnedPointer(1)).toBe(false);

      setArmed.mockClear();
      press(1, 500);
      move(1, 450);
      move(1, 400);
      release(1, 400);

      expect(svc.pan().x).toBeLessThan(0);
      expect(setArmed).not.toHaveBeenCalled();
      expect(editor['commit']).toHaveBeenCalledOnce();
    });

    it('turns into a pinch under a second finger, which still zooms', () => {
      press(1, 400);
      move(1, 420);
      press(2, 600, false);
      expect(editor['cancelGesture']).toHaveBeenCalledOnce();
      expect(svc.isEditOwnedPointer(1)).toBe(false);

      setArmed.mockClear();
      move(1, 300);
      move(2, 700);

      expect(setArmed).not.toHaveBeenCalled();
      expect(svc.pixelScale()).toBeGreaterThan(0);
    });
  });

  describe('a pan started while zoomed in', () => {
    it('never starts a scrub when the canvas returns to fit mid-drag', () => {
      zoomTo(1);
      press(1, 500);
      move(1, 450);
      expect(svc.pan().x).toBeLessThan(0);

      zoomTo(0);
      move(1, 400);
      move(1, 350);

      expect(editor['commit']).not.toHaveBeenCalled();
      expect(setArmed).not.toHaveBeenCalled();
      expect(svc.isEditOwnedPointer(1)).toBe(false);
      expect(view()).toEqual({ pixelScale: 0, pan: { x: 0, y: 0 } });
    });
  });

  function collectWindowErrors(): { errors: string[]; stop: () => void } {
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.message);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    return { errors, stop: () => window.removeEventListener('error', onError) };
  }

  function freshDragPans(id = 1): void {
    zoomTo(1);
    setArmed.mockClear();
    const commits = editor['commit'].mock.calls.length;
    press(id, 500);
    move(id, 450);
    move(id, 400);
    release(id, 400);
    expect(svc.pan().x).toBeLessThan(0);
    expect(setArmed).not.toHaveBeenCalled();
    expect(editor['commit'].mock.calls.length).toBe(commits);
    expect(svc.isEditOwnedPointer(id)).toBe(false);
  }

  describe('ownership ends with the pointer', () => {
    it('on release', () => {
      press(1, 500);
      expect(svc.isEditOwnedPointer(1)).toBe(true);
      release(1, 520);
      expect(svc.isEditOwnedPointer(1)).toBe(false);
      freshDragPans();
    });

    it('on pointercancel, without committing the interrupted value', () => {
      press(1, 500);
      move(1, 540);
      svc.zoomTo100();
      syncRouting();
      g.onPointerUp({ pointerId: 1, clientX: 540, clientY: Y });
      window.dispatchEvent(pointerEvent('pointercancel', 1, 540));

      expect(svc.isEditOwnedPointer(1)).toBe(false);
      expect(editor['cancelGesture']).toHaveBeenCalledOnce();
      expect(editor['endGesture']).not.toHaveBeenCalled();
      freshDragPans();
    });

    it('when the wrap loses its capture, the scrub carries on without a pan', () => {
      press(1, 500);
      svc.zoomTo100();
      syncRouting();
      g.onLostPointerCapture({ pointerId: 1, clientX: 500, clientY: Y });
      const zoomed = view();

      move(1, 600);

      expect(armed()).toBeCloseTo(5, 9);
      expect(view()).toEqual(zoomed);
      release(1, 600);
      expect(svc.isEditOwnedPointer(1)).toBe(false);
      freshDragPans();
    });

    it('under a second finger, whose pinch then ends', () => {
      press(1, 400);
      press(2, 600, false);
      release(2, 600);
      release(1, 400);
      expect(svc.isEditOwnedPointer(1)).toBe(false);
      freshDragPans();
    });

    it('when a new primary press arrives for a scrub that never saw its release', () => {
      press(1, 500);
      press(2, 300);
      expect(svc.isEditOwnedPointer(1)).toBe(false);
      expect(svc.isEditOwnedPointer(2)).toBe(true);
      release(2, 300);
      release(1, 500);
      freshDragPans();
    });

    it('a touch press after a stale mouse claim clears it, and the photo pans', () => {
      press(1, 500);
      g.onLostPointerCapture({ pointerId: 1, clientX: 500, clientY: Y });
      expect(svc.isEditOwnedPointer(1)).toBe(true);
      zoomTo(1);
      setArmed.mockClear();

      press(7, 500, true, 'touch');
      move(7, 450);
      move(7, 400);

      expect(svc.isEditOwnedPointer(1)).toBe(false);
      expect(svc.isEditOwnedPointer(7)).toBe(false);
      expect(svc.pan().x).toBeLessThan(0);
      expect(setArmed).not.toHaveBeenCalled();
      release(7, 400);
    });

    it('when ending the gesture throws on release', () => {
      editor['endGesture'].mockImplementation(() => {
        throw new Error('end failed');
      });
      press(1, 500);
      const { errors, stop } = collectWindowErrors();
      window.dispatchEvent(pointerEvent('pointerup', 1, 520));
      stop();
      expect(errors.join()).toContain('end failed');
      g.onPointerUp({ pointerId: 1, clientX: 520, clientY: Y });

      expect(svc.isEditOwnedPointer(1)).toBe(false);
      setArmed.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', 1, 700));
      expect(setArmed).not.toHaveBeenCalled();
      editor['endGesture'].mockReset();
      freshDragPans();
    });

    it('when cancelling the gesture throws', () => {
      editor['cancelGesture'].mockImplementation(() => {
        throw new Error('cancel failed');
      });
      press(1, 500);
      const { errors, stop } = collectWindowErrors();
      window.dispatchEvent(pointerEvent('pointercancel', 1, 520));
      stop();
      expect(errors.join()).toContain('cancel failed');
      g.onPointerUp({ pointerId: 1, clientX: 520, clientY: Y });

      expect(svc.isEditOwnedPointer(1)).toBe(false);
      setArmed.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', 1, 700));
      expect(setArmed).not.toHaveBeenCalled();
    });
  });
});
