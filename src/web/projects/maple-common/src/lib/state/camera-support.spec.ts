import { describe, expect, it } from 'vitest';
import { CAMERA_TIER_EXPLANATION, FIXTURED_CAMERAS } from '../generated/camera-support.generated';
import { cameraSupportFromJson } from './camera-support';
import { LensCorrectionCapabilities } from './library-store-lens-corrections';

function wire(
  resolution: string,
  cameraKey = 'Unknown camera',
  lens = 'no_correction_data',
): string {
  return JSON.stringify({ cameraKey, resolution, lens });
}

describe('decode-derived camera support', () => {
  it('cannot inherit a profiled camera name when this file actually used fallback calibration', () => {
    const body = FIXTURED_CAMERAS.find((camera) => camera.tier === 'profiled')!;
    expect(cameraSupportFromJson(wire('rawler_fallback', body.key))?.tier).toBe('decode_only');
    expect(cameraSupportFromJson(wire('embedded_cm_only', body.key))?.tier).toBe('matrix_only');
    expect(cameraSupportFromJson(wire('decode_failed', body.key))?.tier).toBe('unsupported');
  });

  it('explains the actual resolver branch for an unknown body and keeps lens support independent', () => {
    const support = cameraSupportFromJson(
      wire('embedded_cm_only', 'Unknown camera', 'embedded_correction'),
    )!;
    expect(support.tier).toBe('matrix_only');
    expect(support.explanation).toBe(CAMERA_TIER_EXPLANATION.matrix_only);
    expect(support.lens).toBe('embedded_correction');
    expect(support.lensLabel).toBe('Embedded correction');
    expect(cameraSupportFromJson(wire('bundle_confident'))?.tier).toBe('profiled');
  });

  it.each([
    undefined,
    null,
    '',
    '{}',
    'invalid',
    wire('future_resolution'),
    wire('__proto__'),
    wire('embedded_full', 'x', 'future_lens'),
  ])('leaves missing or unknown metadata unassessed: %s', (json) => {
    expect(cameraSupportFromJson(json)).toBeUndefined();
  });

  it('keeps per-asset support independent and clears a previous assessment on a new metadata-free decode', () => {
    const store = new LensCorrectionCapabilities();
    store.seed('a', true, false, wire('embedded_full', 'a', 'embedded_correction'));
    store.seed('b', false, true, wire('rawler_fallback', 'b'));
    expect(store.for('a').cameraSupport?.tier).toBe('profiled');
    expect(store.for('b').cameraSupport?.tier).toBe('decode_only');
    store.seed('a', false, true);
    expect(store.for('a').cameraSupport).toBeUndefined();
    expect(store.for('b').cameraSupport?.tier).toBe('decode_only');
  });
});
