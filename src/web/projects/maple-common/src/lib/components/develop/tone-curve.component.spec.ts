// tone-curve.component.spec.ts — the tone curve panel writes (#367).
//
// The plot is only useful if it reaches the AdjustmentModel, so this mounts
// the REAL component (template included) over a LibraryStateService stand-in
// and pins the whole write path: the SVG actually renders, a pointer drag
// authors a knot on the active channel, the channel selector retargets the
// write to a different field, the parametric sliders patch their own fields,
// and reset returns the channel to the EMPTY identity so the sidecar stays
// clean.
//
// It also pins the render-tick bound the ticket asks for: a burst of
// `pointermove` events inside one animation frame must NOT produce one model
// write each. That is the property that keeps a drag off the WASM boundary
// per mouse-move (`render(xmp)` cannot ride the 19-scalar fast path for a
// curve edit — see `image-canvas.live-params.ts`).

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { ToneCurveComponent } from './tone-curve.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { PLOT_SIZE } from './tone-curve.vm';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

const ID = 'asset-curve-1';

class LibraryStub {
  readonly model = signal<AdjustmentModel>(defaultAdjustmentModel());
  writes = 0;

  focusedAssetId(): string {
    return ID;
  }

  adjustmentFor(): Signal<AdjustmentModel> {
    return this.model.asReadonly();
  }

  updateAdjustment(_id: string, patch: Partial<AdjustmentModel>): void {
    this.writes++;
    this.model.update((m) => ({ ...m, ...patch }));
  }
}

class CanvasStub {
  readonly currentPixels = signal(null);
}

describe('ToneCurveComponent (#367)', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ToneCurveComponent>>;
  let panel: ToneCurveComponent;
  let lib: LibraryStub;
  /** rAF callbacks parked by the component, so a test can flush a "frame". */
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    lib = new LibraryStub();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: ImageCanvasService, useValue: new CanvasStub() },
      ],
    });
    fixture = TestBed.createComponent(ToneCurveComponent);
    panel = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run every parked rAF callback — one animation frame. */
  function flushFrame(): void {
    const due = frames;
    frames = [];
    due.forEach((cb) => cb(performance.now()));
  }

  /** The plot element, with a stubbed 200×200 layout box. */
  function plot(): SVGSVGElement {
    const el: SVGSVGElement = fixture.nativeElement.querySelector(
      '[data-testid="tone-curve-plot"]',
    );
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
    return el;
  }

  /** Authoring (x, y) → a PointerEvent on the stubbed 200×200 box. */
  function pointer(type: string, x: number, y: number): PointerEvent {
    return new PointerEvent(type, {
      button: 0,
      clientX: x * 200,
      clientY: (1 - y) * 200,
      bubbles: true,
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────

  it('renders the SVG plot, four channel tabs and four region sliders', () => {
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('[data-testid="tone-curve-plot"]')).toBeTruthy();
    for (const ch of ['luma', 'r', 'g', 'b']) {
      expect(host.querySelector(`[data-testid="tone-curve-channel-${ch}"]`)).toBeTruthy();
    }
    for (const field of [
      'parametricHighlights',
      'parametricLights',
      'parametricDarks',
      'parametricShadows',
    ]) {
      expect(host.querySelector(`[data-testid="tone-curve-${field}"]`)).toBeTruthy();
    }
  });

  it('draws an identity curve as the diagonal, with both corner knots', () => {
    const host: HTMLElement = fixture.nativeElement;
    const d = host.querySelector('.curve')?.getAttribute('d') ?? '';
    expect(d.startsWith(`M 0.00 ${PLOT_SIZE.toFixed(2)}`)).toBe(true);
    expect(d.endsWith(`${PLOT_SIZE.toFixed(2)} 0.00`)).toBe(true);
    expect(host.querySelectorAll('.knot').length).toBe(2);
  });

  it('gives every knot an accessible name — the reason the plot is SVG', () => {
    const knots = fixture.nativeElement.querySelectorAll('.knot');
    knots.forEach((k: Element) => {
      expect(k.getAttribute('aria-label')).toMatch(/curve point \d+ of \d+/);
      expect(k.getAttribute('tabindex')).toBe('0');
    });
  });

  it('announces BOTH axes, so an x-only nudge changes what is spoken', () => {
    // A knot is a 2-D control on a 1-D ARIA slider. ArrowLeft/ArrowRight move
    // x, which `aria-valuenow` structurally cannot represent — without
    // `aria-valuetext` the announced value is simply wrong after every
    // horizontal nudge.
    plot().dispatchEvent(pointer('pointerdown', 0.5, 0.5));
    flushFrame();
    window.dispatchEvent(new PointerEvent('pointerup'));
    fixture.detectChanges();

    const knot = (): Element =>
      fixture.nativeElement.querySelector('[data-testid="tone-curve-knot-1"]');
    expect(knot().getAttribute('aria-valuenow')).toBe('50');
    expect(knot().getAttribute('aria-valuetext')).toBe('input 50%, output 50%');

    knot().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();

    // y is untouched, so aria-valuenow is unchanged — and valuetext is the
    // only attribute carrying the edit the user just made.
    expect(knot().getAttribute('aria-valuenow')).toBe('50');
    expect(knot().getAttribute('aria-valuetext')).toBe('input 52%, output 50%');
  });

  it('nudges on arrows, deletes on Delete, and passes unhandled keys through', () => {
    plot().dispatchEvent(pointer('pointerdown', 0.5, 0.5));
    flushFrame();
    window.dispatchEvent(new PointerEvent('pointerup'));
    fixture.detectChanges();

    const knot = (i: number): Element =>
      fixture.nativeElement.querySelector(`[data-testid="tone-curve-knot-${i}"]`);
    const press = (i: number, init: KeyboardEventInit): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      knot(i).dispatchEvent(e);
      fixture.detectChanges();
      return e;
    };

    // ArrowUp raises y by one step; Shift multiplies the step by four.
    press(1, { key: 'ArrowUp' });
    expect(lib.model().toneCurveLuma.points[1][1]).toBeCloseTo(0.5 + 1 / 64, 6);
    press(1, { key: 'ArrowUp', shiftKey: true });
    expect(lib.model().toneCurveLuma.points[1][1]).toBeCloseTo(0.5 + 5 / 64, 6);

    // An unhandled key is left to the browser.
    expect(press(1, { key: 'a' }).defaultPrevented).toBe(false);

    // Endpoints are pinned: Delete neither removes them nor swallows the key.
    expect(press(0, { key: 'Delete' }).defaultPrevented).toBe(false);
    expect(lib.model().toneCurveLuma.points.length).toBe(3);

    // A mid-curve knot deletes, collapsing back to the empty identity.
    expect(press(1, { key: 'Delete' }).defaultPrevented).toBe(true);
    expect(lib.model().toneCurveLuma.points).toEqual([]);
  });

  // ── Point editing ───────────────────────────────────────────────────────

  it('authors a knot on the active channel from a pointer drag', () => {
    plot().dispatchEvent(pointer('pointerdown', 0.5, 0.5));
    flushFrame();
    window.dispatchEvent(pointer('pointermove', 0.5, 0.8));
    flushFrame();
    window.dispatchEvent(new PointerEvent('pointerup'));

    const points = lib.model().toneCurveLuma.points;
    expect(points.length).toBe(3);
    expect(points[1][0]).toBeCloseTo(0.5, 6);
    expect(points[1][1]).toBeCloseTo(0.8, 6);
    // The other channels are untouched.
    expect(lib.model().toneCurveRed.points).toEqual([]);
  });

  it('retargets the write when the channel selector changes', () => {
    fixture.nativeElement.querySelector('[data-testid="tone-curve-channel-g"]').click();
    fixture.detectChanges();

    plot().dispatchEvent(pointer('pointerdown', 0.3, 0.3));
    flushFrame();
    window.dispatchEvent(new PointerEvent('pointerup'));

    expect(lib.model().toneCurveGreen.points.length).toBe(3);
    expect(lib.model().toneCurveLuma.points).toEqual([]);
  });

  it('resets a channel back to the EMPTY identity, not the corner anchors', () => {
    plot().dispatchEvent(pointer('pointerdown', 0.5, 0.7));
    flushFrame();
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(lib.model().toneCurveLuma.points.length).toBe(3);

    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="tone-curve-reset-channel"]').click();
    expect(lib.model().toneCurveLuma.points).toEqual([]);
  });

  // ── Render-tick bound ───────────────────────────────────────────────────

  it('coalesces a burst of pointermoves into ONE model write per frame', () => {
    plot().dispatchEvent(pointer('pointerdown', 0.5, 0.5));
    flushFrame();
    const afterInsert = lib.writes;

    // Twenty moves inside a single frame — a high-rate pointer mid-drag.
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(pointer('pointermove', 0.5, 0.5 + i * 0.01));
    }
    expect(lib.writes).toBe(afterInsert); // nothing has crossed the boundary yet
    flushFrame();
    expect(lib.writes).toBe(afterInsert + 1); // exactly one write for the frame

    // Release flushes the final position even if the frame never fired.
    window.dispatchEvent(pointer('pointermove', 0.5, 0.9));
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(lib.model().toneCurveLuma.points[1][1]).toBeCloseTo(0.9, 6);
  });

  // ── Parametric sliders ──────────────────────────────────────────────────

  it('patches the parametric field its slider owns', () => {
    panel.onParametricChange({ field: 'parametricDarks', label: 'Darks' }, -42);
    expect(lib.model().parametricDarks).toBe(-42);
    expect(lib.model().parametricLights).toBe(0);

    panel.onParametricReset({ field: 'parametricDarks', label: 'Darks' });
    expect(lib.model().parametricDarks).toBe(0);
  });
});
