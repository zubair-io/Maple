// Resolution-JSON validation + the per-asset verdict store (#3479).

import { describe, expect, it } from 'vitest';
import { lensProfileFromJson } from './lens-profile.metadata';
import { lensProfileDigest } from './lens-profile-cache';
import { LensCorrectionCapabilities } from '../state/library-store-lens-corrections';

const reference = `lcp1:${'a'.repeat(64)}`;
const facts = {
  source: 'lcp',
  confidence: 'in-range',
  reference,
  enabled: true,
  approximations: [],
  unsupported: [],
  hasDistortion: true,
  hasCa: false,
  hasVignetting: true,
  ca: [],
  vignetting: [],
  distortion: [{ index: 2, weight: 1, focalMm: 35, apertureApex: 4, focusM: 5 }],
};

describe('lensProfileFromJson', () => {
  it('keeps the selected samples and the per-family calibration presence', () => {
    const profile = lensProfileFromJson(JSON.stringify(facts));
    expect(profile?.distortion?.[0].index).toBe(2);
    expect(profile?.hasCa).toBe(false);
    expect(profile?.reference).toBe(reference);
  });

  it('accepts the embedded-wins marker', () => {
    const embedded = lensProfileFromJson(
      JSON.stringify({
        source: 'embedded',
        confidence: 'embedded',
        reference,
        approximations: [],
        unsupported: [],
      }),
    );
    expect(embedded?.source).toBe('embedded');
  });

  it.each([
    undefined,
    '{}',
    'null',
    'bad',
    JSON.stringify({ ...facts, ca: {} }),
    JSON.stringify({ ...facts, distortion: [{ index: 0, weight: '1' }] }),
    JSON.stringify({ ...facts, approximations: [1] }),
    JSON.stringify({ ...facts, confidence: 'embedded' }),
    JSON.stringify({ ...facts, hasCa: 'no' }),
    JSON.stringify({ ...facts, source: 'embedded', confidence: 'in-range' }),
  ])('leaves malformed metadata unassessed: %s', (json) => {
    expect(lensProfileFromJson(json)).toBeUndefined();
  });
});

describe('LensCorrectionCapabilities — imported profile verdict', () => {
  it('keeps the verdict beside the opcode facts and clears it explicitly', () => {
    const profile = lensProfileFromJson(JSON.stringify(facts))!;
    const store = new LensCorrectionCapabilities();
    store.seed('asset', false, true, undefined, profile);
    expect(store.for('asset').lensProfile?.reference).toBe(reference);
    expect(store.for('asset').cameraSupport).toBeUndefined();
    // Omitted: retained (a decode reply that says nothing keeps the last word).
    store.seed('asset', false, true);
    expect(store.for('asset').lensProfile?.reference).toBe(reference);
    // Explicit null: cleared, opcode facts untouched.
    store.seedProfile('asset', null);
    expect(store.for('asset').lensProfile).toBeUndefined();
    expect(store.for('asset').hasLensCorrections).toBe(false);
    // A re-render's verdict lands without a decode-time seed for the asset.
    store.seedProfile('fresh', profile);
    expect(store.for('fresh')).toEqual({
      hasLensCorrections: false,
      lensCorrectionCaInert: true,
      lensProfile: profile,
    });
  });
});

describe('lensProfileDigest', () => {
  it('names the same bytes for plain and acknowledged references', () => {
    expect(lensProfileDigest(reference)).toBe('a'.repeat(64));
    expect(lensProfileDigest(reference.replace('lcp1:', 'lcp1-ack:'))).toBe('a'.repeat(64));
  });

  it('rejects future versions and malformed digests', () => {
    expect(() => lensProfileDigest(`lcp2:${'a'.repeat(64)}`)).toThrow('Unsupported');
    expect(() => lensProfileDigest('lcp1:../../profile')).toThrow('Unsupported');
    expect(() => lensProfileDigest(`lcp1:${'A'.repeat(64)}`)).toThrow('Unsupported');
  });
});
