// jsdom's `<canvas>.getContext('2d')` is null and it never fires real
// `Image` decode callbacks (same limitation documented across the plot
// components — see internal/plot-canvas.spec.ts). This spec mocks the 2D
// context at the prototype level (curve-plot's pattern) and drives decode
// outcomes through the component's public `handleImageLoaded`/
// `handleImageError` seam instead of racing a real network `Image` load
// (mui-remote-image's pattern).

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiImageCanvasComponent } from './mui-image-canvas.component';
import type { MuiImageTransform } from './mui-image-canvas.component';

function fakeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
}

function fakeImage(width = 400, height = 300): HTMLImageElement {
  return { naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

function render(): ComponentFixture<MuiImageCanvasComponent> {
  TestBed.configureTestingModule({ imports: [MuiImageCanvasComponent] });
  const fixture = TestBed.createComponent(MuiImageCanvasComponent);
  fixture.componentRef.setInput('src', 'main.jpg');
  fixture.detectChanges();
  return fixture;
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, clientY, pointerId, bubbles: true });
}

function wheelEvent(deltaY: number, clientX: number, clientY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true });
}

describe('MuiImageCanvasComponent', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx() as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
    } as DOMRect);
    // jsdom's HTMLCanvasElement.prototype has no setPointerCapture at all (unlike
    // getContext/getBoundingClientRect, which jsdom stubs), so vi.spyOn — which
    // requires the property to already exist — can't target it. Direct
    // assignment works regardless, matching mui-drag-bar.component.spec.ts's
    // `bar.setPointerCapture = () => {}` convention for the same gap.
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the preview-image fallback while no image has decoded yet', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-preview-image')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-canvas-surface')).toBeNull();
  });

  it('switches to the canvas once the image decodes, sized to its aspect ratio', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(400, 200), 1);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-canvas-surface')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-preview-image')).toBeNull();
    expect(fixture.componentInstance.contentAspect()).toBe(2);
  });

  it('showBefore swaps activeSrc to beforeSrc when both are set', () => {
    const fixture = render();
    fixture.componentRef.setInput('beforeSrc', 'before.jpg');
    fixture.detectChanges();
    expect(fixture.componentInstance.activeSrc()).toBe('main.jpg');

    fixture.componentRef.setInput('showBefore', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeSrc()).toBe('before.jpg');
  });

  it('showBefore with no beforeSrc set falls back to src', () => {
    const fixture = render();
    fixture.componentRef.setInput('showBefore', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeSrc()).toBe('main.jpg');
  });

  it('a stale decode does not clobber a newer one (generation guard)', () => {
    const fixture = render();
    const stale = fakeImage(100, 100);
    const fresh = fakeImage(400, 200);

    fixture.componentRef.setInput('src', 'other.jpg'); // bumps the load generation
    fixture.detectChanges();

    fixture.componentInstance.handleImageLoaded(fresh, 2);
    fixture.componentInstance.handleImageLoaded(stale, 1); // stale generation — ignored
    fixture.detectChanges();

    expect(fixture.componentInstance.readyImage()).toBe(fresh);
  });

  it('wheel-in increases scale and emits transformChanged', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(), 1);
    fixture.detectChanges();

    const emitted: MuiImageTransform[] = [];
    fixture.componentInstance.transformChanged.subscribe((t) => emitted.push(t));

    const canvas: HTMLElement = fixture.nativeElement.querySelector('canvas');
    canvas.dispatchEvent(wheelEvent(-100, 200, 150));
    fixture.detectChanges();

    expect(emitted.length).toBe(1);
    expect(emitted[0].scale).toBeGreaterThan(1);
  });

  it('wheel-out clamps scale to the configured minimum', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(), 1);
    fixture.detectChanges();

    const canvas: HTMLElement = fixture.nativeElement.querySelector('canvas');
    canvas.dispatchEvent(wheelEvent(1000, 200, 150));
    canvas.dispatchEvent(wheelEvent(1000, 200, 150));
    fixture.detectChanges();

    expect(fixture.componentInstance.transform().scale).toBeCloseTo(0.1);
  });

  it('pointer drag pans the transform by the drag delta', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(), 1);
    fixture.detectChanges();

    const canvas: HTMLElement = fixture.nativeElement.querySelector('canvas');
    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    canvas.dispatchEvent(pointerEvent('pointermove', 130, 120));
    fixture.detectChanges();

    expect(fixture.componentInstance.transform()).toEqual({ x: 30, y: 20, scale: 1 });
  });

  it('pointerup ends the drag — a stray pointermove afterward does not pan further', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(), 1);
    fixture.detectChanges();

    const canvas: HTMLElement = fixture.nativeElement.querySelector('canvas');
    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    canvas.dispatchEvent(pointerEvent('pointermove', 130, 120));
    canvas.dispatchEvent(pointerEvent('pointerup', 130, 120));
    canvas.dispatchEvent(pointerEvent('pointermove', 999, 999));
    fixture.detectChanges();

    expect(fixture.componentInstance.transform()).toEqual({ x: 30, y: 20, scale: 1 });
  });

  it('renders the crop overlay only in crop mode, and bubbles its committed rect', () => {
    const fixture = render();
    fixture.componentInstance.handleImageLoaded(fakeImage(), 1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-crop-overlay')).toBeNull();

    fixture.componentRef.setInput('cropMode', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-crop-overlay')).toBeTruthy();

    const emitted: { x: number; y: number; width: number; height: number }[] = [];
    fixture.componentInstance.cropRectChanged.subscribe((r) => emitted.push(r));
    const nextRect = { x: 10, y: 10, width: 50, height: 50 };
    fixture.componentInstance.onCropRectChange(nextRect);
    expect(emitted).toEqual([nextRect]);
  });
});
