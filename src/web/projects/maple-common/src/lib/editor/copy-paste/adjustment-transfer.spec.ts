import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import {
  buildTransferPatch,
  relativeWhiteBalanceDescription,
  snapWhiteBalanceBaseline,
  type AdjustmentTransferRequest,
} from './adjustment-transfer';

const request = (): AdjustmentTransferRequest => ({
  source: {
    ...defaultAdjustmentModel(),
    temperature: 6200,
    tint: 13,
    wbSource: 'Manual',
    whiteBalancePreset: 'Custom',
  },
  groups: ['white_balance', 'geometry'],
  relativeWhiteBalance: true,
  sourceBaseline: { temperature: 5000, tint: 3 },
});
describe('semantic adjustment transfer', () => {
  it('snaps camera baselines identically to Apple for negative half-tint values', () => {
    expect(snapWhiteBalanceBaseline({ temperature: 5025, tint: -0.5 })).toEqual({
      temperature: 5050,
      tint: -1,
    });
    expect(snapWhiteBalanceBaseline({ temperature: 4974, tint: -1.5 })).toEqual({
      temperature: 4950,
      tint: -2,
    });
    expect(snapWhiteBalanceBaseline({ temperature: 5000, tint: 0.5 }).tint).toBe(1);
  });
  it('applies the source correction to target as-shot and clears source sample provenance', () => {
    const input = request();
    input.source.wbSampleX = 0.3;
    input.source.wbAlgorithmVersion = 2;
    const patch = buildTransferPatch(input, { temperature: 7000, tint: -5 });
    expect(patch).toMatchObject({
      temperature: 8200,
      tint: 5,
      wbSource: 'Manual',
      whiteBalancePreset: 'Custom',
      wbScaleVersion: 5,
      wbSampleX: 0,
      wbAlgorithmVersion: 0,
    });
  });
  it('retains absolute paste as the default and normalizes crop against the target', () => {
    const input = request();
    input.relativeWhiteBalance = false;
    input.source.crop = { top: 0.1, left: 0.2, bottom: 0.7, right: 0.8, angle: 0 };
    const patch = buildTransferPatch(input);
    expect(patch.temperature).toBe(6200);
    expect(patch.crop).toEqual(input.source.crop);
    expect(patch.crop).not.toBe(input.source.crop);
  });
  it('treats As Shot as zero correction even before the source sliders have been seeded', () => {
    const input = request();
    input.source = defaultAdjustmentModel();
    expect(buildTransferPatch(input, { temperature: 4000, tint: -7 })).toMatchObject({
      temperature: 4000,
      tint: -7,
    });
  });
  it('rejects missing baselines and legacy scales instead of silently copying neutral numbers', () => {
    expect(() => buildTransferPatch(request())).toThrow('as-shot');
    expect(() =>
      buildTransferPatch(
        { ...request(), sourceBaseline: undefined },
        { temperature: 4000, tint: 0 },
      ),
    ).toThrow('as-shot');
    const input = request();
    input.source.wbScaleVersion = 1;
    expect(() => buildTransferPatch(input, { temperature: 4000, tint: 0 })).toThrow(
      'current-scale',
    );
  });
  it('caps relative results at the authored schema domain', () => {
    expect(buildTransferPatch(request(), { temperature: 11900, tint: 149 })).toMatchObject({
      temperature: 12000,
      tint: 150,
    });
  });
  it('describes a relative expression before an unopened target has been decoded', () => {
    const preview = relativeWhiteBalanceDescription(request(), [defaultAdjustmentModel()]);
    expect(preview).toBe('As Shot → each photo’s As Shot +1200 K, tint +10');
  });
});
