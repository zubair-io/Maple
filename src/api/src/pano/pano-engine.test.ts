import { describe, expect, it } from 'bun:test';
import { ML_FALLBACK_NOTE, planPanoEngine } from './pano-engine.ts';

const paths = { models_dir: '/models', ort_dylib_path: '/ort/libonnxruntime.so' };
const noPaths = { models_dir: null, ort_dylib_path: null };

describe('planPanoEngine', () => {
  it('runs the classical matcher when it is selected', () => {
    expect(planPanoEngine({ matcher: 'classical', ...paths }, true)).toEqual({
      kind: 'run',
      featuresEngine: 'classical',
      matcherNote: null,
    });
  });

  it('runs ML when it is selected and both paths are set', () => {
    expect(planPanoEngine({ matcher: 'ml', ...paths }, true)).toEqual({
      kind: 'run',
      featuresEngine: 'ml',
      matcherNote: null,
    });
  });

  it('falls back to classical with a note when ML is selected but its models are missing', () => {
    expect(planPanoEngine({ matcher: 'ml', ...noPaths }, true)).toEqual({
      kind: 'run',
      featuresEngine: 'classical',
      matcherNote: ML_FALLBACK_NOTE,
    });
  });

  it('falls back when only one of the two ML paths is set', () => {
    const modelsOnly = planPanoEngine(
      { matcher: 'ml', models_dir: '/models', ort_dylib_path: null },
      true,
    );
    const ortOnly = planPanoEngine(
      { matcher: 'ml', models_dir: null, ort_dylib_path: '/ort/libonnxruntime.so' },
      true,
    );
    expect(modelsOnly).toMatchObject({
      featuresEngine: 'classical',
      matcherNote: ML_FALLBACK_NOTE,
    });
    expect(ortOnly).toMatchObject({ featuresEngine: 'classical', matcherNote: ML_FALLBACK_NOTE });
  });

  it('runs a binary without --features-engine as ML when both paths are set', () => {
    expect(planPanoEngine({ matcher: 'classical', ...paths }, false)).toEqual({
      kind: 'run',
      featuresEngine: null,
      matcherNote: null,
    });
  });

  it('refuses a binary without a classical matcher when ML is not set up', () => {
    const plan = planPanoEngine({ matcher: 'ml', ...noPaths }, false);
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.error).toBe('pano_cli_outdated');
    expect(plan.message).not.toMatch(/cargo|#\d|--features/);
  });
});
