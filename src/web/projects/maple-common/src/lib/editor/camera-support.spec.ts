// The Web consumer of the generated camera / lens support registry (#2440).
// The tiers are computed in Rust (raw-core/src/support_tiers/) and emitted
// by tools/codegen.sh; this spec pins what the web shell relies on: a
// stable tier vocabulary, an explanation for every state the UI can show,
// the resolver mapping, and that a tier is never hand-promoted.
import { describe, expect, it } from 'vitest';
import {
  CAMERA_SUPPORT_BUILD,
  CAMERA_TIER_EXPLANATION,
  CAMERA_TIER_LABEL,
  FIXTURED_CAMERAS,
  LENS_SUPPORT_EXPLANATION,
  LENS_SUPPORT_LABEL,
  TIER_FOR_RESOLUTION,
  type CameraTier,
} from '../generated/camera-support.generated';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-model.generated';

/** Worst to best — the order the Rust `CameraTier` declares. */
const TIER_ORDER: readonly CameraTier[] = [
  'unsupported',
  'decode_only',
  'matrix_only',
  'profiled',
  'qualified',
];

const rank = (tier: CameraTier): number => TIER_ORDER.indexOf(tier);

describe('camera support registry', () => {
  it('was generated for the pipeline version the web caches key on', () => {
    expect(CAMERA_SUPPORT_BUILD.pipelineOutputVersion).toBe(PIPELINE_OUTPUT_VERSION);
    expect(CAMERA_SUPPORT_BUILD.bundledModelCount).toBeGreaterThan(1000);
    // Every tier here was computed against a specific profile bundle;
    // regenerating it regenerates this file.
    expect(CAMERA_SUPPORT_BUILD.profileBundleFormat).toBe(1);
    expect(CAMERA_SUPPORT_BUILD.profileBundleDigest).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  it('explains every tier and lens state, distinctly', () => {
    // The explanation is the product surface: "why does this look off" has
    // to be answerable without the UI writing its own copy.
    const tierTexts = TIER_ORDER.map((t) => CAMERA_TIER_EXPLANATION[t]);
    expect(new Set(tierTexts).size).toBe(TIER_ORDER.length);
    expect(tierTexts.every((t) => t.length > 0)).toBe(true);
    expect(TIER_ORDER.every((t) => CAMERA_TIER_LABEL[t].length > 0)).toBe(true);

    const lensTexts = Object.values(LENS_SUPPORT_EXPLANATION);
    expect(new Set(lensTexts).size).toBe(lensTexts.length);
    expect(lensTexts.every((t) => t.length > 0)).toBe(true);
    expect(Object.values(LENS_SUPPORT_LABEL).every((t) => t.length > 0)).toBe(true);
  });

  it('maps every resolver branch to a tier', () => {
    expect(TIER_FOR_RESOLUTION).toEqual({
      embedded_full: 'profiled',
      bundle_confident: 'profiled',
      embedded_cm_only: 'matrix_only',
      rawler_fallback: 'decode_only',
      decode_failed: 'unsupported',
    });
  });

  it('never reports a body below the tier its resolution already earns', () => {
    expect(FIXTURED_CAMERAS.length).toBeGreaterThan(0);
    const keys = FIXTURED_CAMERAS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const camera of FIXTURED_CAMERAS) {
      expect(camera.displayName.length).toBeGreaterThan(0);
      expect(rank(camera.tier)).toBeGreaterThanOrEqual(
        rank(TIER_FOR_RESOLUTION[camera.resolution]),
      );
    }
  });

  it('never claims qualified without a resolver branch that could back it', () => {
    for (const camera of FIXTURED_CAMERAS.filter((c) => c.tier === 'qualified')) {
      expect(['embedded_full', 'bundle_confident']).toContain(camera.resolution);
    }
  });
});
