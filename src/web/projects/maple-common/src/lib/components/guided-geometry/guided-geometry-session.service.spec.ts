import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuidedGeometrySessionService } from './guided-geometry-session.service';
import { GuidedGeometryOverlayComponent } from './guided-geometry-overlay.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type {
  GuidedCorrection,
  GuidedGeometryRequest,
} from '../../raw-pipeline/raw-pipeline.guided-geometry';
import { EditTransactionRing } from '../../editor/edit-transaction-ring';

function harness() {
  const model = signal({ ...defaultAdjustmentModel(), exposure: 1, perspectiveScale: 115 });
  const id = signal<string | null>('asset-1');
  const tool = signal('geometry');
  const updateAdjustment = vi.fn((_id: string, patch: object) =>
    model.update((m) => ({ ...m, ...patch })),
  );
  const ring = new EditTransactionRing();
  const serializer = new XmpSerializerService();
  const commit = vi.fn((kind, description) => ring.open(kind, description, model()));
  const endEdit = vi.fn(() => ring.close(serializer, model()));
  const solve = vi
    .fn<(input: Omit<GuidedGeometryRequest, 'id' | 'type'>) => Promise<GuidedCorrection>>()
    .mockResolvedValue({
      perspectiveVertical: 20,
      perspectiveHorizontal: -10,
      perspectiveRotate: 3,
      limited: false,
    });
  TestBed.configureTestingModule({
    providers: [
      {
        provide: LibraryStateService,
        useValue: {
          focusedAssetId: id,
          focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
          adjustmentFor: () => model,
          updateAdjustment,
        },
      },
      { provide: EditorStateService, useValue: { armedTool: tool, commit, endEdit } },
      { provide: RawPipelineService, useValue: { solveGuidedGeometry: solve } },
      XmpSerializerService,
      ImageCanvasService,
    ],
  });
  const canvas = TestBed.inject(ImageCanvasService);
  canvas.nativeDimensions.set({ w: 6000, h: 4000 });
  const session = TestBed.inject(GuidedGeometrySessionService);
  const draw = () => {
    session.add({ start: { x: 0.2, y: 0.1 }, end: { x: 0.25, y: 0.9 } });
    session.add({ start: { x: 0.8, y: 0.1 }, end: { x: 0.75, y: 0.9 } });
  };
  TestBed.tick();
  return { session, model, id, tool, solve, draw, ring, updateAdjustment, canvas, serializer };
}

describe('Guided geometry session', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { name: 'offset', geometry: { perspectiveX: 50 }, cropped: false },
    { name: 'rotation', geometry: { perspectiveRotate: 10 }, cropped: false },
    { name: 'keystone and crop', geometry: { perspectiveVertical: 30 }, cropped: true },
  ])(
    'passes post-perspective guide endpoints to the solver under $name',
    async ({ geometry, cropped }) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe(): void {}
          disconnect(): void {}
        },
      );
      const h = harness();
      const crop = cropped
        ? { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9, angle: 0 }
        : defaultAdjustmentModel().crop;
      h.model.set({ ...h.model(), perspectiveScale: 100, ...geometry, crop });
      h.session.start('vertical');
      const fixture = TestBed.createComponent(GuidedGeometryOverlayComponent);
      const width = cropped ? 360 : 600;
      const height = cropped ? 320 : 400;
      Object.defineProperties(fixture.nativeElement, {
        clientWidth: { value: width },
        clientHeight: { value: height },
      });
      fixture.detectChanges();
      const surface = fixture.nativeElement.querySelector('svg') as SVGElement;
      surface.setPointerCapture = vi.fn();
      surface.releasePointerCapture = vi.fn();
      const send = (type: string, x: number, y: number) => {
        const event = new MouseEvent(type, {
          clientX: x * width,
          clientY: y * height,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        surface.dispatchEvent(event);
      };
      for (const x of [0.3, 0.7]) {
        send('pointerdown', x, 0.2);
        send('pointerup', x, 0.8);
      }
      const expected = cropped
        ? [0.38, 0.26, 0.38, 0.74, 0.62, 0.26, 0.62, 0.74]
        : [0.3, 0.2, 0.3, 0.8, 0.7, 0.2, 0.7, 0.8];
      expect(h.session.lines()).toHaveLength(2);
      expect(h.session.lines()[0].start.x).toBeCloseTo(expected[0], 9);
      await h.session.apply();
      expect(h.solve).toHaveBeenCalledOnce();
      h.solve.mock.calls[0][0].points.forEach((value, index) =>
        expect(value).toBeCloseTo(expected[index], 9),
      );
    },
  );
  it('applies exactly one real edit transaction and preserves other settings', async () => {
    const h = harness();
    h.session.start('vertical');
    h.draw();
    expect(h.updateAdjustment).not.toHaveBeenCalled();
    await h.session.apply();
    expect(h.model().perspectiveVertical).toBe(20);
    expect(h.model().exposure).toBe(1);
    expect(h.model().perspectiveScale).toBe(115);
    expect(h.session.active()).toBe(false);
    const tx = h.ring.popUndo();
    expect(tx?.before.perspectiveVertical).toBe(0);
    expect(tx?.after.perspectiveVertical).toBe(20);
    expect(h.ring.popUndo()).toBeNull();
    expect(h.solve.mock.calls[0]?.[0]).toMatchObject({ family: 'vertical', aspect: 1.5 });
  });
  it('requires both pairs for a four-guide correction', () => {
    const h = harness();
    h.session.start('both');
    h.draw();
    expect(h.session.canApply()).toBe(false);
    expect(h.session.instruction()).toContain('horizontal');
    h.session.add({ start: { x: 0.1, y: 0.2 }, end: { x: 0.9, y: 0.2 } });
    h.session.add({ start: { x: 0.1, y: 0.8 }, end: { x: 0.9, y: 0.8 } });
    expect(h.session.canApply()).toBe(true);
    h.session.removeLast();
    expect(h.session.canApply()).toBe(false);
  });
  it('drops a pending solve after cancellation, asset switch, or an external edit', async () => {
    for (const invalidate of ['cancel', 'asset', 'edit', 'tool']) {
      TestBed.resetTestingModule();
      const h = harness();
      let finish!: (c: GuidedCorrection) => void;
      h.solve.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      h.session.start('vertical');
      h.draw();
      const applying = h.session.apply();
      if (invalidate === 'cancel') h.session.cancel();
      if (invalidate === 'asset') h.id.set('asset-2');
      if (invalidate === 'edit') h.model.update((m) => ({ ...m, exposure: 2 }));
      if (invalidate === 'tool') h.tool.set('crop');
      finish({
        perspectiveVertical: 20,
        perspectiveHorizontal: 0,
        perspectiveRotate: 0,
        limited: false,
      });
      await applying;
      TestBed.tick();
      expect(h.updateAdjustment).not.toHaveBeenCalled();
      expect(h.session.active()).toBe(false);
    }
  });
  it('lets the user redraw after a solver rejection without changing pixels or history', async () => {
    const h = harness();
    h.solve.mockRejectedValue(new Error('Choose two different edges.'));
    h.session.start('vertical');
    h.draw();
    await h.session.apply();
    expect(h.session.message()).toContain('different edges');
    expect(h.session.busy()).toBe(false);
    expect(h.session.active()).toBe(true);
    expect(h.updateAdjustment).not.toHaveBeenCalled();
  });
  it('refuses drawing before native dimensions arrive and rejects tiny guides', () => {
    const h = harness();
    h.canvas.nativeDimensions.set(null);
    h.session.start('vertical');
    expect(h.session.active()).toBe(false);
    h.canvas.nativeDimensions.set({ w: 6000, h: 4000 });
    h.session.start('vertical');
    h.session.add({ start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 } });
    expect(h.session.lines()).toHaveLength(0);
    expect(h.session.message()).toContain('longer');
  });
});
