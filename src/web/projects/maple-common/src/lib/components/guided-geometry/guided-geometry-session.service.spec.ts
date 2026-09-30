import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuidedGeometrySessionService } from './guided-geometry-session.service';
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
        useValue: { focusedAssetId: id, adjustmentFor: () => model, updateAdjustment },
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
