// adjustment-clipboard.service.spec.ts — clipboard signal behavior (#944).
//
// The service has no injected dependencies (just `signal`/`computed`), so
// these tests instantiate it directly rather than pulling in
// `TestBed` — a plain `new` keeps the spec runnable under bare `vitest run`
// as well as the Angular test builder.

import { describe, beforeEach, expect, it } from 'vitest';

import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { AdjustmentClipboardService } from './adjustment-clipboard.service';

describe('AdjustmentClipboardService', () => {
  let service: AdjustmentClipboardService;

  beforeEach(() => {
    service = new AdjustmentClipboardService();
  });

  it('starts empty', () => {
    expect(service.hasContents()).toBe(false);
    expect(service.entry()).toBeNull();
  });

  it('copyFrom populates the entry and hasContents flips true', () => {
    const model = defaultAdjustmentModel();
    model.exposure = 1.5;
    service.copyFrom('asset-1', 'IMG_0001.dng', model);

    expect(service.hasContents()).toBe(true);
    const entry = service.entry();
    expect(entry?.sourceAssetId).toBe('asset-1');
    expect(entry?.sourceLabel).toBe('IMG_0001.dng');
    expect(entry?.model.exposure).toBe(1.5);
  });

  it('clear empties the clipboard', () => {
    service.copyFrom('asset-1', 'IMG_0001.dng', defaultAdjustmentModel());
    service.clear();
    expect(service.hasContents()).toBe(false);
    expect(service.entry()).toBeNull();
  });

  it('deep-copies crop so later source-model mutation cannot affect the snapshot', () => {
    const model = defaultAdjustmentModel();
    model.crop = { top: 0, left: 0, bottom: 1, right: 1, angle: 0 };
    service.copyFrom('asset-1', 'IMG_0001.dng', model);

    model.crop.angle = 90; // mutate the caller's copy after copyFrom

    expect(service.entry()?.model.crop.angle).toBe(0);
  });

  it('a later copyFrom replaces the previous entry', () => {
    service.copyFrom('asset-1', 'IMG_0001.dng', defaultAdjustmentModel());
    const second = defaultAdjustmentModel();
    second.contrast = -20;
    service.copyFrom('asset-2', 'IMG_0002.dng', second);

    const entry = service.entry();
    expect(entry?.sourceAssetId).toBe('asset-2');
    expect(entry?.model.contrast).toBe(-20);
  });
});
