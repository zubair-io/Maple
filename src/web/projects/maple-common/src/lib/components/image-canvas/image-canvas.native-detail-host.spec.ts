import { describe, expect, it, vi } from 'vitest';
import { canvasDisplayDims, createNativeDetail } from './image-canvas.native-detail-host';
import type { ImageCanvasComponent } from './image-canvas.component';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

function setup() {
  const crop = { left: 0, top: 0, right: 1, bottom: 1, angle: 0 };
  const model = { ...defaultAdjustmentModel(), crop };
  let disabled = false,
    scale = 1,
    split: number | null = null;
  const pipeline = {
    closeNativeDetail: vi.fn(),
    renderNativeDetail: vi.fn(async () => {
      throw new Error('test ends at worker request');
    }),
  };
  const host = {
    pipeline,
    currentAssetId: 'one',
    currentBytes: new Uint8Array([1]),
    currentExt: 'dng',
    renderGeneration: 1,
    serializeForRender: () => 'xmp',
    state: { focusedAsset: () => ({ id: 'one' }), adjustmentFor: () => () => model },
    canvasSvc: {
      nativeDimensions: () => ({ w: 6000, h: 4000 }),
      paintedAspect: () => ({ w: 800, h: 533 }),
      pixelScale: () => scale,
      beforeAfterSplitX: () => split,
    },
    wrapW: () => 800,
    wrapH: () => 600,
    currentLayout: () => ({ canvasW: 3000, canvasH: 2000, pan: { x: 0, y: 0 } }),
  };
  const detail = createNativeDetail(host as unknown as ImageCanvasComponent, () => disabled);
  detail.recordBase({
    assetId: 'one',
    generation: 1,
    renderXmp: 'xmp',
    displayXmp: 'xmp',
    sizing: { maxLongEdge: 800, qualityPreview: true },
  });
  return {
    host,
    crop,
    model,
    pipeline,
    detail,
    disable: () => (disabled = true),
    zoomOut: () => (scale = 0.99),
    compare: () => (split = 0.5),
  };
}

describe('native-detail host eligibility', () => {
  it('uses oriented native dimensions at 100% instead of the sized bitmap extent', () => {
    const { host } = setup();
    expect(canvasDisplayDims(host as unknown as ImageCanvasComponent)).toEqual({
      w: 6000,
      h: 4000,
    });
  });

  it('keeps the rendered aspect for an applied crop', () => {
    const { host, crop } = setup();
    crop.right = 0.6;
    expect(canvasDisplayDims(host as unknown as ImageCanvasComponent)).toEqual({ w: 800, h: 533 });
  });

  it('requests source pixels at true 100% on the CPU RAW canvas', async () => {
    const s = setup();
    await s.detail.render('xmp', 1);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledOnce();
  });

  for (const mode of ['master-off', 'zero-scales']) {
    it(`allows native detail for a disabled external profile (${mode})`, async () => {
      const s = setup();
      s.model.lensProfile = `lcp1:${'a'.repeat(64)}`;
      if (mode === 'master-off') s.model.lensProfileEnable = 'Off';
      else {
        s.model.lensCorrectionDistortion = 0;
        s.model.lensCorrectionCa = 0;
        s.model.lensCorrectionVignetting = 0;
      }
      await s.detail.render('xmp', 1);
      expect(s.pipeline.renderNativeDetail).toHaveBeenCalledOnce();
    });
  }

  for (const mode of [
    'gpu-or-crop-tool',
    'applied-crop',
    'before-after',
    'below-100',
    'non-raw',
    'stale-asset',
    'manual-geometry',
    'external-profile',
  ]) {
    it(`keeps the sized fallback for ${mode}`, async () => {
      const s = setup();
      if (mode === 'gpu-or-crop-tool') s.disable();
      if (mode === 'applied-crop') s.crop.angle = 3;
      if (mode === 'before-after') s.compare();
      if (mode === 'below-100') s.zoomOut();
      if (mode === 'non-raw') s.host.currentExt = 'jpg';
      if (mode === 'stale-asset') s.host.currentAssetId = 'two';
      if (mode === 'manual-geometry') s.model.geoRotation = 5;
      if (mode === 'external-profile') s.model.lensProfile = `lcp1:${'a'.repeat(64)}`;
      expect(await s.detail.render('xmp', 1)).toBe(false);
      expect(s.pipeline.renderNativeDetail).not.toHaveBeenCalled();
    });
  }
});
