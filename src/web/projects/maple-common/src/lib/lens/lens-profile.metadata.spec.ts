import { describe, expect, it } from 'vitest';
import { lensProfileFromJson } from './lens-profile.metadata';
import { LensCorrectionCapabilities } from '../state/library-store-lens-corrections';

const facts = {
  source: 'lcp',
  confidence: 'in-range',
  reference: `lcp1:${'a'.repeat(64)}`,
  approximations: [],
  unsupported: [],
  ca: [],
  vignetting: [],
  distortion: [{ index: 2, weight: 1, focalMm: 35, apertureApex: 4, focusM: 5 }],
};

describe('imported optical decode metadata', () => {
  it('retains actual selected samples and keeps camera qualification separate', () => {
    const profile = lensProfileFromJson(JSON.stringify(facts));
    expect(profile?.distortion?.[0].index).toBe(2);
    const store = new LensCorrectionCapabilities();
    store.seed('asset', false, true, undefined, profile);
    expect(store.for('asset').lensProfile?.reference).toBe(facts.reference);
    expect(store.for('asset').cameraSupport).toBeUndefined();
    store.seed('asset', false, true);
    expect(store.for('asset').lensProfile).toBeUndefined();
  });

  it.each([
    undefined,
    '{}',
    'null',
    'bad',
    JSON.stringify({ ...facts, ca: {} }),
    JSON.stringify({ ...facts, distortion: [{ index: 0, weight: '1' }] }),
    JSON.stringify({ ...facts, approximations: [1] }),
  ])('leaves malformed metadata unassessed: %s', (json) => {
    expect(lensProfileFromJson(json)).toBeUndefined();
  });
});
