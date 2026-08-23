import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiCurvePlotComponent } from './mui-curve-plot.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
  };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true });
}

function render(): { fixture: ComponentFixture<MuiCurvePlotComponent>; canvas: HTMLCanvasElement } {
  TestBed.configureTestingModule({ imports: [MuiCurvePlotComponent] });
  const fixture = TestBed.createComponent(MuiCurvePlotComponent);
  fixture.componentRef.setInput('width', 100);
  fixture.componentRef.setInput('height', 100);
  fixture.detectChanges();
  const canvas: HTMLCanvasElement = fixture.nativeElement.querySelector('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
  canvas.setPointerCapture = () => {};
  return { fixture, canvas };
}

describe('MuiCurvePlotComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with three default points and draws a circle per point', () => {
    const { fixture } = render();
    expect(fixture.componentInstance.points()).toHaveLength(3);
    expect(ctx.arc).toHaveBeenCalledTimes(3);
  });

  it('dragging the middle point (canvas coords 50,50 for {x:0.5,y:0.5}) updates its normalized position', () => {
    const { fixture, canvas } = render();
    canvas.dispatchEvent(pointerEvent('pointerdown', 50, 50));
    fixture.detectChanges();
    expect(fixture.componentInstance.activeIndex()).toBe(1);

    canvas.dispatchEvent(pointerEvent('pointermove', 70, 20));
    fixture.detectChanges();

    const points = fixture.componentInstance.points();
    expect(points[1].x).toBeCloseTo(0.7);
    expect(points[1].y).toBeCloseTo(0.8); // canvas y=20 → normalized y = 1 - 20/100

    canvas.dispatchEvent(pointerEvent('pointerup', 70, 20));
    canvas.dispatchEvent(pointerEvent('pointermove', 90, 90));
    fixture.detectChanges();
    // pointerup ends the drag — a stray move afterward must not move the point.
    expect(fixture.componentInstance.points()[1].x).toBeCloseTo(0.7);
  });

  it('a click away from every point does not select or move anything', () => {
    const { fixture, canvas } = render();
    canvas.dispatchEvent(pointerEvent('pointerdown', 50, 90));
    fixture.detectChanges();
    expect(fixture.componentInstance.activeIndex()).toBeNull();
  });

  it('arrow keys nudge the active point once selected, clamped to [0, 1]', () => {
    const { fixture, canvas } = render();
    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 0)); // the {x:1,y:1} point
    fixture.detectChanges();
    expect(fixture.componentInstance.activeIndex()).toBe(2);

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    // y is already 1 — nudging up stays clamped at 1.
    expect(fixture.componentInstance.points()[2].y).toBe(1);

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.points()[2].y).toBeCloseTo(0.98);
  });

  it('does nothing on arrow keys before any point has been selected', () => {
    const { fixture, canvas } = render();
    const before = fixture.componentInstance.points();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.points()).toEqual(before);
  });
});
