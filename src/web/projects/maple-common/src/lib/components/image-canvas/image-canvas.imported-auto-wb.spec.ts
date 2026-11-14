// Name-only imported Auto WB that becomes active on an already-open photo (a
// variant selection, a history restore) resolves on that photo's worker session,
// not only at cold open (#4669, #5882 review).
import { Injector, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvasAdjustmentEffect } from './image-canvas.adjustment-effect';
import { importedAutoBackgroundEstimate } from './image-canvas.imported-auto-wb';
import type { ImageCanvasComponent } from './image-canvas.component';
import { MaskSessionService } from '../mask-overlay/mask-session.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { withResolvedImportedAuto } from '../../models/partial-white-balance';
import type { WorkflowVariantSelectionService } from '../../xmp/workflow-variant-selection.service';

const ID = 'lib:a.dng';
const pair = { temperature: 4800, tint: 6 };
const numeric: AdjustmentModel = {
  ...defaultAdjustmentModel(),
  whiteBalancePreset: 'Custom',
  temperature: 5200,
  tint: 3,
};
/** A variant or checkpoint whose sidecar names Auto without numbers. */
const nameOnlyAuto: AdjustmentModel = {
  ...defaultAdjustmentModel(),
  whiteBalancePreset: 'Auto',
  partialWhiteBalance: { version: 5 },
};

function setup() {
  const model = signal(numeric);
  const bytes = new Uint8Array([1, 2, 3]);
  const resolveImportedWhiteBalance = vi.fn(async (_bytes: Uint8Array) => pair);
  const resolveImportedAutoWhiteBalance = vi.fn((_id: string, landed: typeof pair) =>
    model.update((current) => withResolvedImportedAuto(current, landed)),
  );
  const scheduleRerender = vi.fn();
  const host = {
    state: {
      focusedAsset: () => ({ id: ID, filename: 'a.dng' }),
      adjustmentFor: () => computed(() => model()),
      resolveImportedAutoWhiteBalance,
    },
    pipeline: { resolveImportedWhiteBalance },
    currentAssetId: ID,
    currentBytes: bytes,
    coldOpenDone: true,
    byteLoadError: () => null,
    serializeForRender: (value: AdjustmentModel) => JSON.stringify(value),
    lastRenderedXmp: JSON.stringify(numeric),
    filmSync: { syncIfNeeded: vi.fn(), ensureCpuLutResolving: vi.fn() },
    gpuPresent: { active: () => true },
    scheduleRerender,
  } as unknown as ImageCanvasComponent;
  const variants = {
    current: () => ({ scope: 'folder', variantId: 'primary' }),
  } as unknown as WorkflowVariantSelectionService;
  const cleanup = new ImageCanvasAdjustmentEffect(host, variants).wire(TestBed.inject(Injector));
  return {
    model,
    bytes,
    cleanup,
    resolveImportedWhiteBalance,
    resolveImportedAutoWhiteBalance,
    scheduleRerender,
  };
}

let cleanup: (() => void) | undefined;
beforeEach(() => {
  importedAutoBackgroundEstimate.enabled = true;
  TestBed.configureTestingModule({
    providers: [
      { provide: MaskSessionService, useValue: { brush: { rasterRevision: signal(0) } } },
    ],
  });
});
afterEach(() => {
  importedAutoBackgroundEstimate.enabled = false;
  cleanup?.();
  cleanup = undefined;
  TestBed.resetTestingModule();
});

describe('imported Auto WB introduced after the cold open', () => {
  it('resolves once on the open session and re-renders with the pair', async () => {
    const t = setup();
    cleanup = t.cleanup;
    TestBed.tick();
    expect(t.resolveImportedWhiteBalance).not.toHaveBeenCalled();

    t.model.set(nameOnlyAuto);
    TestBed.tick();
    expect(t.resolveImportedWhiteBalance).toHaveBeenCalledOnce();
    expect(t.resolveImportedWhiteBalance).toHaveBeenCalledWith(t.bytes);
    await Promise.resolve();
    expect(t.resolveImportedAutoWhiteBalance).toHaveBeenCalledWith(ID, pair);

    TestBed.tick();
    const rendered = JSON.parse(t.scheduleRerender.mock.lastCall![0] as string) as AdjustmentModel;
    expect([rendered.temperature, rendered.tint]).toEqual([pair.temperature, pair.tint]);
    expect(t.resolveImportedWhiteBalance).toHaveBeenCalledOnce();
  });

  it('asks nothing for a photo whose WB is not name-only Auto', () => {
    const t = setup();
    cleanup = t.cleanup;
    t.model.set({ ...numeric, exposure: 1 });
    TestBed.tick();
    expect(t.resolveImportedWhiteBalance).not.toHaveBeenCalled();
    expect(t.scheduleRerender).toHaveBeenCalled();
  });

  it('asks nothing while the background estimate is staged off (#5923)', () => {
    importedAutoBackgroundEstimate.enabled = false;
    const t = setup();
    cleanup = t.cleanup;
    t.model.set(nameOnlyAuto);
    TestBed.tick();
    expect(t.resolveImportedWhiteBalance).not.toHaveBeenCalled();
    expect(t.scheduleRerender).toHaveBeenCalled();
  });
});
