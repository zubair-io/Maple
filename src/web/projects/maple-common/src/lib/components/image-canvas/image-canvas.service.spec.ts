// image-canvas.service.spec.ts — the momentary before/after peek and the
// bounded step-zoom request (#2450). Zoom and pan are their own signals, so
// a peek preserves them by construction; these tests pin the split
// bookkeeping the peek adds on top of the latched toggle.

import { describe, expect, it } from 'vitest';
import { ImageCanvasService } from './image-canvas.service';

describe('ImageCanvasService — momentary before/after', () => {
  it('peeks at the whole frame and restores an off split', () => {
    const svc = new ImageCanvasService();
    svc.setPixelScale(2);
    svc.pan.set({ x: 9, y: -4 });
    svc.beginPeekBefore();
    expect(svc.peekingBefore()).toBe(true);
    expect(svc.beforeAfterSplitX()).toBe(1);
    expect(svc.latchedBeforeAfter()).toBe(false);
    // The latched toggle is inert while peeking.
    svc.toggleBeforeAfter();
    expect(svc.beforeAfterSplitX()).toBe(1);
    svc.endPeekBefore();
    expect(svc.peekingBefore()).toBe(false);
    expect(svc.beforeAfterSplitX()).toBeNull();
    expect(svc.pixelScale()).toBe(2);
    expect(svc.pan()).toEqual({ x: 9, y: -4 });
  });

  it('restores a latched split exactly, and is idempotent', () => {
    const svc = new ImageCanvasService();
    svc.toggleBeforeAfter();
    svc.setSplit(0.3);
    svc.beginPeekBefore();
    svc.beginPeekBefore();
    expect(svc.beforeAfterSplitX()).toBe(1);
    svc.endPeekBefore();
    svc.endPeekBefore();
    expect(svc.beforeAfterSplitX()).toBe(0.3);
    expect(svc.latchedBeforeAfter()).toBe(true);
  });

  it('counts step-zoom requests so a host answers each once', () => {
    const svc = new ImageCanvasService();
    expect(svc.stepZoomRequest().seq).toBe(0);
    svc.requestStepZoom(1);
    svc.requestStepZoom(-1);
    expect(svc.stepZoomRequest()).toEqual({ seq: 2, direction: -1 });
  });
});
