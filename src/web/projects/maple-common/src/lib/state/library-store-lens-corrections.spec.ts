// library-store-lens-corrections.spec.ts — unit tests for the #3182
// per-asset decode-derived lens-correction capability signal.

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LENS_CORRECTION_CAPABILITY,
  LensCorrectionCapabilities,
} from './library-store-lens-corrections';
import type { AssetId } from '../models/asset';

const ASSET_A = 'asset-a' as AssetId;
const ASSET_B = 'asset-b' as AssetId;

describe('LensCorrectionCapabilities', () => {
  it('reports the fail-closed default (panel disabled, CA inert) for an unseeded asset', () => {
    const caps = new LensCorrectionCapabilities();
    expect(caps.for(ASSET_A)()).toEqual(DEFAULT_LENS_CORRECTION_CAPABILITY);
    expect(DEFAULT_LENS_CORRECTION_CAPABILITY).toEqual({
      hasLensCorrections: false,
      lensCorrectionCaInert: true,
    });
  });

  it('reflects the seeded capability once decode resolves', () => {
    const caps = new LensCorrectionCapabilities();
    caps.seed(ASSET_A, true, false);
    expect(caps.for(ASSET_A)()).toEqual({
      hasLensCorrections: true,
      lensCorrectionCaInert: false,
    });
  });

  it('is reactive — the computed signal updates in place after a re-seed', () => {
    const caps = new LensCorrectionCapabilities();
    const signal = caps.for(ASSET_A);
    expect(signal().hasLensCorrections).toBe(false);

    caps.seed(ASSET_A, true, true);
    expect(signal().hasLensCorrections).toBe(true);
    expect(signal().lensCorrectionCaInert).toBe(true);
  });

  it('keeps per-asset capabilities independent', () => {
    const caps = new LensCorrectionCapabilities();
    caps.seed(ASSET_A, true, false);
    caps.seed(ASSET_B, false, true);

    expect(caps.for(ASSET_A)()).toEqual({ hasLensCorrections: true, lensCorrectionCaInert: false });
    expect(caps.for(ASSET_B)()).toEqual(DEFAULT_LENS_CORRECTION_CAPABILITY);
  });

  it('re-seeding the same asset overwrites, not merges, its capability', () => {
    const caps = new LensCorrectionCapabilities();
    caps.seed(ASSET_A, true, false);
    caps.seed(ASSET_A, false, true);
    expect(caps.for(ASSET_A)()).toEqual(DEFAULT_LENS_CORRECTION_CAPABILITY);
  });
});
