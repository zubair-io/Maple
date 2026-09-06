// editor-state.auto.spec.ts — AUTO (#1379), calibrated tone sliders (#2255).
//
// Split out of `editor-state.service.spec.ts` for the file-size budget
// (CONTRIBUTING.md "File-size budget" — a changed file may not grow past
// 570 lines); the shared store stand-in lives in `editor-state.test-helpers.ts`,
// mirroring `editor-state.commit-on-release.spec.ts`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EditorStateService } from './editor-state.service';
import { makeLibraryStub, type LibraryStub } from './editor-state.test-helpers';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';
import { ADJUSTMENT_RANGES } from '../generated/adjustment-tables.generated';

// Fake RawPipelineService — returns a configurable auto-adjust patch.
class PipelineStub {
  patch: AutoAdjustPatch = {
    exposure: 0.5,
    temperature: 5800,
    tint: 5,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
  };

  computeAutoAdjustments = vi.fn(
    (_bytes: Uint8Array, _ext: string, _xmp?: string): Promise<AutoAdjustPatch> =>
      Promise.resolve(this.patch),
  );
}

describe('EditorStateService — applyAuto (#1379/#2255)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;
  let pipeline: PipelineStub;

  const ID = 'asset-1';

  beforeEach(() => {
    lib = makeLibraryStub();
    pipeline = new PipelineStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: pipeline },
      ],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
  });

  const BYTES = new Uint8Array([1, 2, 3]);
  beforeEach(() => {
    lib.primeBytes(ID, BYTES);
  });

  it.each(['Auto', 'Neutral'] as const)(
    'keeps the %s profile through Auto Tone and its single Undo entry',
    async (profile) => {
      lib.updateAdjustment(ID, { profile, exposure: -1 });
      await svc.applyAuto(ID);
      expect(lib.adjustmentFor(ID)().profile).toBe(profile);
      expect(svc.undoHistory()).toHaveLength(1);
      svc.undo();
      expect(lib.adjustmentFor(ID)().profile).toBe(profile);
      expect(lib.adjustmentFor(ID)().exposure).toBe(-1);
      svc.redo();
      expect(lib.adjustmentFor(ID)().profile).toBe(profile);
      expect(lib.adjustmentFor(ID)().exposure).toBe(pipeline.patch.exposure);
    },
  );

  it('writes exposure + the five calibrated tone sliders + autoExposure=Off — leaves white balance untouched (#2255)', async () => {
    pipeline.patch = {
      exposure: 0.5,
      temperature: 5800,
      tint: 5,
      contrast: 12,
      highlights: -18,
      shadows: 22,
      whites: -6,
      blacks: -9,
    };
    lib.updateAdjustment(ID, {
      contrast: 20,
      highlights: -30,
      shadows: 40,
      whites: -10,
      blacks: -5,
    });
    const before = lib.adjustmentFor(ID)();
    const ok = await svc.applyAuto(ID);
    expect(ok).toBe(true);
    const adj = lib.adjustmentFor(ID)();
    // The core's calibrated recommendation (#1376) lands byte-identically —
    // same values a user drag would write, not discarded.
    expect(adj.exposure).toBeCloseTo(pipeline.patch.exposure, 9);
    expect(adj.contrast).toBeCloseTo(pipeline.patch.contrast, 9);
    expect(adj.highlights).toBeCloseTo(pipeline.patch.highlights, 9);
    expect(adj.shadows).toBeCloseTo(pipeline.patch.shadows, 9);
    expect(adj.whites).toBeCloseTo(pipeline.patch.whites, 9);
    expect(adj.blacks).toBeCloseTo(pipeline.patch.blacks, 9);
    expect(adj.autoExposure).toBe('Off');
    // White balance is NOT touched — WB stays at As-Shot.
    expect(adj.temperature).toBe(before.temperature);
    expect(adj.tint).toBe(before.tint);
    expect(svc.autoResult()).toBe('Auto applied · Exposure +0.50 EV');

    svc.bind('other-image');
    expect(svc.autoResult()).toBeNull();
  });

  it('clamps out-of-range tone values to each field’s canonical range', async () => {
    pipeline.patch = {
      exposure: 99,
      temperature: 99999,
      tint: 999,
      contrast: 999,
      highlights: -999,
      shadows: 999,
      whites: -999,
      blacks: 999,
    };
    const ok = await svc.applyAuto(ID);
    expect(ok).toBe(true);
    const adj = lib.adjustmentFor(ID)();
    // Bounds come from the generated raw-core ranges, not literals, so a
    // range tweak in codegen cannot silently desynchronise this spec.
    expect(adj.exposure).toBeCloseTo(ADJUSTMENT_RANGES.exposure[1], 9);
    expect(adj.contrast).toBeCloseTo(ADJUSTMENT_RANGES.contrast[1], 9);
    expect(adj.highlights).toBeCloseTo(ADJUSTMENT_RANGES.highlights[0], 9);
    expect(adj.shadows).toBeCloseTo(ADJUSTMENT_RANGES.shadows[1], 9);
    expect(adj.whites).toBeCloseTo(ADJUSTMENT_RANGES.whites[0], 9);
    expect(adj.blacks).toBeCloseTo(ADJUSTMENT_RANGES.blacks[1], 9);
    // The feedback message reports the CLAMPED exposure that was actually
    // written, not the raw out-of-range recommendation (#3130 review).
    expect(svc.autoResult()).toBe(
      `Auto applied · Exposure +${ADJUSTMENT_RANGES.exposure[1].toFixed(2)} EV`,
    );
  });

  it('creates ONE undo entry that restores the pre-AUTO tone sliders too', async () => {
    pipeline.patch = {
      exposure: 0.5,
      temperature: 5800,
      tint: 5,
      contrast: 12,
      highlights: -18,
      shadows: 22,
      whites: -6,
      blacks: -9,
    };
    lib.updateAdjustment(ID, { contrast: 20, blacks: -5 });
    const ok = await svc.applyAuto(ID);
    expect(ok).toBe(true);
    expect(svc.canUndo()).toBe(true);
    svc.undo();
    const adj = lib.adjustmentFor(ID)();
    expect(adj.contrast).toBeCloseTo(20, 9);
    expect(adj.blacks).toBeCloseTo(-5, 9);
  });

  it('creates exactly ONE undo entry and has in-flight guards', async () => {
    lib.updateAdjustment(ID, { exposure: 1.5 });
    const p1 = svc.applyAuto(ID);
    expect(svc.autoInFlight()).toBe(true);
    const p2 = svc.applyAuto(ID);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(pipeline.computeAutoAdjustments).toHaveBeenCalledTimes(1);
    expect(svc.autoInFlight()).toBe(false);

    expect(svc.canUndo()).toBe(true);
    svc.undo();
    expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(1.5, 9);
    expect(svc.canUndo()).toBe(false);
  });

  it('stale guard drops a patch after bind(OTHER)', async () => {
    const OTHER = 'asset-other';
    lib.assets.set([
      { id: ID, filename: 'test.dng' },
      { id: OTHER, filename: 'other.dng' },
    ]);
    lib.primeBytes(OTHER, BYTES);

    let resolvePatch!: (p: AutoAdjustPatch) => void;
    pipeline.computeAutoAdjustments.mockImplementation(
      () =>
        new Promise<AutoAdjustPatch>((r) => {
          resolvePatch = r;
        }),
    );

    const p = svc.applyAuto(ID);
    svc.bind(OTHER);
    resolvePatch(pipeline.patch);
    const result = await p;
    expect(result).toBe(false);
    expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0, 9);
  });

  it('returns false on pipeline rejection or if no image is bound', async () => {
    pipeline.computeAutoAdjustments.mockRejectedValue(new Error('decode failed'));
    expect(await svc.applyAuto(ID)).toBe(false);
    expect(svc.autoInFlight()).toBe(false);
    expect(svc.autoResult()).toBe('Auto could not be applied');

    let rejectAnalysis!: (error: Error) => void;
    pipeline.computeAutoAdjustments.mockReturnValue(
      new Promise((_, reject) => (rejectAnalysis = reject)),
    );
    const staleRequest = svc.applyAuto(ID);
    svc.bind('other-image');
    rejectAnalysis(new Error('stale decode failed'));
    expect(await staleRequest).toBe(false);
    expect(svc.autoResult()).toBeNull();

    svc.imageId.set(null);
    expect(await svc.applyAuto(ID)).toBe(false);
  });
});
