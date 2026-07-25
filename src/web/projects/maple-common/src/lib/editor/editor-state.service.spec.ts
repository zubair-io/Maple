// editor-state.service.spec.ts — responsive-program S5c (#625).
//
// Mirror of Apple's EditorStateTests. Covers arming, value pipe,
// commit/undo/redo ring (cap 32), reset semantics, stub-tool no-op,
// and the wired-vs-stub catalog math.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EditorStateService, UNDO_STACK_CAP } from './editor-state.service';
import { makeLibraryStub, type LibraryStub } from './editor-state.test-helpers';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { ALL_TOOLS, TOOLS_IN_GROUP, defaultDisplayValue, groupOf, isWired } from './tool-model';
import { defaultGeneratedAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';

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

describe('EditorStateService', () => {
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

  describe('arming', () => {
    it('defaults to (light, exposure)', () => {
      expect(svc.armedGroup()).toBe('light');
      expect(svc.armedTool()).toBe('exposure');
    });

    it('switches group when arming a tool from another group', () => {
      svc.armTool('clarity');
      expect(svc.armedTool()).toBe('clarity');
      expect(svc.armedGroup()).toBe('effects');
    });

    it('retains tool when arming the same group', () => {
      svc.armTool('shadows');
      svc.armGroup('light');
      expect(svc.armedTool()).toBe('shadows');
    });

    it('switches tool when arming a different group', () => {
      svc.armGroup('color');
      expect(svc.armedTool()).toBe('temp');
    });
  });

  describe('value pipe', () => {
    it('writes display values through to the AdjustmentModel field', () => {
      svc.armTool('exposure');
      svc.setArmedDisplayValue(0.5);
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0.5, 9);
      expect(svc.armedDisplayValue()).toBeCloseTo(0.5, 9);
    });

    it('maps internal -100..+100 through to the tool range', () => {
      svc.armTool('exposure');
      svc.setArmedInternalValue(100);
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(4, 9);

      svc.armTool('temp');
      svc.setArmedInternalValue(50);
      expect(lib.adjustmentFor(ID)().temperature).toBeCloseTo(9250, 9);
    });

    it('rejects writes to stub tools', () => {
      const before = { ...lib.adjustmentFor(ID)() };
      svc.armTool('crop');
      svc.setArmedDisplayValue(50);
      expect(lib.adjustmentFor(ID)()).toEqual(before);
    });

    it('presets is wired but value-less: drags and resets are inert (#1115)', () => {
      const before = { ...lib.adjustmentFor(ID)() };
      svc.armTool('presets');
      svc.setArmedDisplayValue(50);
      svc.resetArmedTool();
      expect(lib.adjustmentFor(ID)()).toEqual(before);
      expect(svc.armedDisplayValue()).toBe(0);
      expect(svc.canUndo()).toBe(false);
    });

    it('colorGrade is wired (#275): drags write balance, sub-params write the wheels', () => {
      svc.armTool('colorGrade');
      svc.setArmedDisplayValue(25);
      expect(lib.adjustmentFor(ID)().splitToneBalance).toBe(25);
      svc.armSubParam('shadowHue');
      svc.setArmedDisplayValue(30);
      expect(lib.adjustmentFor(ID)().splitToneShadowHue).toBe(30);
      svc.armSubParam('shadowSat');
      svc.setArmedDisplayValue(60);
      expect(lib.adjustmentFor(ID)().splitToneShadowSaturation).toBe(60);
      svc.armSubParam('highlightHue');
      svc.setArmedDisplayValue(210);
      expect(lib.adjustmentFor(ID)().splitToneHighlightHue).toBe(210);
      svc.armSubParam('highlightSat');
      svc.setArmedDisplayValue(40);
      expect(lib.adjustmentFor(ID)().splitToneHighlightSaturation).toBe(40);
      expect(lib.adjustmentFor(ID)().splitToneBalance).toBe(25);
    });

    it('grain is wired (#1110): drags write grainAmount, sub-params write size/roughness', () => {
      svc.armTool('grain');
      svc.setArmedDisplayValue(40);
      expect(lib.adjustmentFor(ID)().grainAmount).toBe(40);
      svc.armSubParam('size');
      svc.setArmedDisplayValue(70);
      expect(lib.adjustmentFor(ID)().grainSize).toBe(70);
      svc.armSubParam('roughness');
      svc.setArmedDisplayValue(20);
      expect(lib.adjustmentFor(ID)().grainRoughness).toBe(20);
      expect(lib.adjustmentFor(ID)().grainAmount).toBe(40);
    });

    it('vignette is wired (#1109): drags write vignetteAmount, sub-param writes feather', () => {
      svc.armTool('vignette');
      svc.setArmedDisplayValue(-50);
      expect(lib.adjustmentFor(ID)().vignetteAmount).toBe(-50);
      svc.armSubParam('feather');
      svc.setArmedDisplayValue(80);
      expect(lib.adjustmentFor(ID)().vignetteFeather).toBe(80);
      expect(lib.adjustmentFor(ID)().vignetteAmount).toBe(-50);
    });
  });

  describe('sub-params (#1108, spec §10.0)', () => {
    it('arming a multi-param tool defaults to its first sub-param', () => {
      svc.armTool('noise');
      expect(svc.armedSubParamId()).toBe('luminance');
      svc.armTool('sharpen');
      expect(svc.armedSubParamId()).toBe('amount');
    });

    it('single-param tools carry no armed sub-param', () => {
      svc.armTool('exposure');
      expect(svc.armedSubParamId()).toBeNull();
      expect(svc.armedSubParam()).toBeNull();
      expect(svc.armedSubParams()).toEqual([]);
    });

    it('armSubParam routes the value pipe to the sub-param field', () => {
      svc.armTool('noise');
      svc.armSubParam('color');
      expect(svc.armedSubParamId()).toBe('color');

      svc.setArmedDisplayValue(60);
      const adj = lib.adjustmentFor(ID)();
      expect(adj.nrColor).toBe(60);
      expect(adj.nrLuminance).toBe(0);
      expect(svc.armedDisplayValue()).toBe(60);
    });

    it('internal values map through the armed sub-param (radius pivots on 1.0)', () => {
      svc.armTool('sharpen');
      svc.armSubParam('radius');
      svc.setArmedInternalValue(100);
      expect(lib.adjustmentFor(ID)().sharpenRadius).toBeCloseTo(3.0, 9);
      svc.setArmedInternalValue(-100);
      expect(lib.adjustmentFor(ID)().sharpenRadius).toBeCloseTo(0.5, 9);
      svc.setArmedInternalValue(0);
      expect(lib.adjustmentFor(ID)().sharpenRadius).toBeCloseTo(1.0, 9);
      expect(svc.armedInternalValue()).toBeCloseTo(0, 9);
    });

    it('reset acts on the ARMED sub-param only, restoring its canonical default', () => {
      svc.armTool('noise');
      svc.setArmedDisplayValue(80);
      svc.armSubParam('color');
      svc.setArmedDisplayValue(90);
      svc.resetArmedTool();
      const adj = lib.adjustmentFor(ID)();
      expect(adj.nrColor).toBe(25);
      expect(adj.nrLuminance).toBe(80);
    });

    // The commit-on-release sub-params (#1153) have their own suite in
    // `editor-state.commit-on-release.spec.ts`.

    it('remembers the armed sub-param per tool for the session (across tool switches and binds)', () => {
      svc.armTool('noise');
      svc.armSubParam('color');
      svc.armTool('exposure');
      svc.armTool('noise');
      expect(svc.armedSubParamId()).toBe('color');

      svc.bind('asset-2');
      expect(svc.armedSubParamId()).toBe('color');
    });

    it('ignores undeclared sub-param ids (and any id on single-param tools)', () => {
      svc.armTool('noise');
      svc.armSubParam('bogus');
      expect(svc.armedSubParamId()).toBe('luminance');
      svc.armTool('exposure');
      svc.armSubParam('luminance');
      expect(svc.armedSubParamId()).toBeNull();
    });

    it('armedToolAcceptsValueEdits is sub-param-aware and still gates value-less tools', () => {
      svc.armTool('noise');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('sharpen');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('exposure');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('vignette');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('grain');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('colorGrade');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('hsl');
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      for (const tool of ['presets', 'crop'] as const) {
        svc.armTool(tool);
        expect(svc.armedToolAcceptsValueEdits()).toBe(false);
      }
    });
  });

  describe('brightness pill (#1108 / #1102)', () => {
    it('joins the Light group and writes the brightness field', () => {
      svc.armTool('brightness');
      expect(svc.armedGroup()).toBe('light');
      svc.setArmedDisplayValue(30);
      expect(lib.adjustmentFor(ID)().brightness).toBe(30);
      svc.resetArmedTool();
      expect(lib.adjustmentFor(ID)().brightness).toBe(0);
    });
  });

  describe('undo / redo ring', () => {
    it('snapshots the model on commit and rewinds on undo', () => {
      svc.armTool('contrast');
      expect(svc.canUndo()).toBe(false);
      svc.commit();
      svc.setArmedDisplayValue(25);
      expect(svc.canUndo()).toBe(true);

      svc.undo();
      expect(lib.adjustmentFor(ID)().contrast).toBe(0);
      expect(svc.canRedo()).toBe(true);

      svc.redo();
      expect(lib.adjustmentFor(ID)().contrast).toBe(25);
    });

    it(`caps the ring at ${UNDO_STACK_CAP} entries (FIFO)`, () => {
      svc.armTool('exposure');
      for (let i = 1; i <= 40; i++) {
        svc.commit();
        svc.setArmedDisplayValue(i * 0.01);
      }
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0.4, 9);
      for (let i = 0; i < UNDO_STACK_CAP; i++) svc.undo();
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0.08, 9);
      expect(svc.canUndo()).toBe(false);
      svc.undo();
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0.08, 9);
    });

    it('resetArmedTool snapshots before restoring the default', () => {
      svc.armTool('temp');
      svc.setArmedDisplayValue(7500);
      svc.resetArmedTool();
      expect(lib.adjustmentFor(ID)().temperature).toBe(6500);
      svc.undo();
      expect(lib.adjustmentFor(ID)().temperature).toBe(7500);
    });

    it('resetArmedTool returns Color NR to its default', () => {
      svc.armTool('colorNR');
      svc.setArmedDisplayValue(80);
      svc.resetArmedTool();
      expect(lib.adjustmentFor(ID)().nrColor).toBe(25);
    });
  });

  describe('applyPreset (#1115)', () => {
    const preset = (fields: Record<string, number | string | boolean>) => ({
      id: 'p1',
      schemaVersion: 1,
      name: 'Test',
      fields,
      builtIn: false,
    });

    it('sparse-merges known fields and pushes exactly ONE undo entry', () => {
      svc.armTool('exposure');
      svc.commit();
      svc.setArmedDisplayValue(1.5);

      const ok = svc.applyPreset(preset({ contrast: -50, saturation: -100 }));
      expect(ok).toBe(true);

      const after = lib.adjustmentFor(ID)();
      expect(after.contrast).toBe(-50);
      expect(after.saturation).toBe(-100);
      expect(after.exposure).toBeCloseTo(1.5, 9);

      svc.undo();
      const undone = lib.adjustmentFor(ID)();
      expect(undone.contrast).toBe(0);
      expect(undone.saturation).toBe(0);
      expect(undone.exposure).toBeCloseTo(1.5, 9);

      svc.redo();
      expect(lib.adjustmentFor(ID)().contrast).toBe(-50);
      expect(lib.adjustmentFor(ID)().saturation).toBe(-100);
    });

    it('clamps out-of-range numeric values to the generated range', () => {
      expect(svc.applyPreset(preset({ exposure: 9.5, contrast: -400 }))).toBe(true);
      expect(lib.adjustmentFor(ID)().exposure).toBe(4);
      expect(lib.adjustmentFor(ID)().contrast).toBe(-100);
    });

    it('skips unknown fields (newer schema) but applies the known ones', () => {
      const before = { ...lib.adjustmentFor(ID)() };
      expect(svc.applyPreset(preset({ future_curve_strength: 0.5, contrast: 10 }))).toBe(true);
      expect(lib.adjustmentFor(ID)()).toEqual({ ...before, contrast: 10 });
    });

    it('applies known enum variants and skips unknown ones', () => {
      expect(svc.applyPreset(preset({ profile: 'Neutral', tone_curve_mode: 'FutureMode' }))).toBe(
        true,
      );
      const after = lib.adjustmentFor(ID)();
      expect(after.profile).toBe('Neutral');
      expect(after.toneCurveMode).toBe('PerChannel');
    });

    it('returns false and pushes no undo entry when nothing applies', () => {
      expect(svc.applyPreset(preset({ future_only: 1 }))).toBe(false);
      expect(svc.canUndo()).toBe(false);

      svc.imageId.set(null);
      expect(svc.applyPreset(preset({ contrast: 10 }))).toBe(false);
    });
  });

  describe('resetAll (M1 — reset-all button)', () => {
    const dirtyCrop = { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5 };

    const dirty = () =>
      lib.updateAdjustment(ID, {
        exposure: 2,
        contrast: 40,
        saturation: -30,
        sharpenAmount: 120,
        profile: 'Neutral',
        whiteBalancePreset: 'Custom',
        crop: dirtyCrop,
      });

    it('restores every develop slider to its factory default in ONE undo step', () => {
      dirty();
      lib.setAsShot(ID, { temperature: 5200, tint: 7 });
      const before = structuredClone(lib.adjustmentFor(ID)());

      expect(svc.resetAll()).toBe(true);

      const after = lib.adjustmentFor(ID)();
      const gd = defaultGeneratedAdjustmentModel();
      for (const k of Object.keys(gd) as Array<keyof typeof gd>) {
        if (k === 'temperature' || k === 'tint') continue;
        expect(after[k as keyof AdjustmentModel]).toEqual(gd[k]);
      }
      expect(after.contrast).toBe(0);
      expect(after.saturation).toBe(0);
      expect(after.sharpenAmount).toBe(40);

      expect(svc.canUndo()).toBe(true);
      svc.undo();
      expect(lib.adjustmentFor(ID)()).toEqual(before);
    });

    it('resets white balance, profile and preserves crop', () => {
      dirty();
      lib.setAsShot(ID, { temperature: 5200, tint: 7 });
      svc.resetAll();
      const after = lib.adjustmentFor(ID)();
      expect(after.temperature).toBe(5200);
      expect(after.tint).toBe(7);
      expect(after.whiteBalancePreset).toBe('As Shot');
      expect(after.profile).toBe('Auto');
      expect(after.crop).toEqual(dirtyCrop);
    });

    it('handles defaults and unbound images on resetAll', () => {
      dirty();
      svc.resetAll();
      const after = lib.adjustmentFor(ID)();
      expect(after.temperature).toBe(6500);
      expect(after.tint).toBe(0);
      expect(after.profile).toBe('Auto');
      svc.bind(ID);
      svc.imageId.set(null);
      expect(svc.resetAll()).toBe(false);
      expect(svc.canUndo()).toBe(false);
    });
  });
  describe('applyAuto (#1379)', () => {
    const BYTES = new Uint8Array([1, 2, 3]);
    beforeEach(() => {
      lib.primeBytes(ID, BYTES);
    });

    it('writes exposure + autoExposure=Off ONLY — leaves white balance and tone sliders untouched', async () => {
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
      expect(adj.exposure).toBeCloseTo(pipeline.patch.exposure, 9);
      expect(adj.autoExposure).toBe('Off');
      expect(adj.temperature).toBe(before.temperature);
      expect(adj.tint).toBe(before.tint);
      expect(adj.contrast).toBe(before.contrast);
      expect(adj.highlights).toBe(before.highlights);
      expect(adj.shadows).toBe(before.shadows);
      expect(adj.whites).toBe(before.whites);
      expect(adj.blacks).toBe(before.blacks);
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

      svc.imageId.set(null);
      expect(await svc.applyAuto(ID)).toBe(false);
    });
  });

  describe('tool catalog', () => {
    it('verifies tool registry configuration', () => {
      expect(ALL_TOOLS.length).toBe(24);
      expect(TOOLS_IN_GROUP.light.length).toBe(7);
      expect(TOOLS_IN_GROUP.color.length).toBe(6);
      expect(TOOLS_IN_GROUP.effects.length).toBe(6);
      expect(TOOLS_IN_GROUP.detail.length).toBe(5);

      const wired = ALL_TOOLS.filter(isWired);
      expect(wired.length).toBe(23);
      expect(isWired('vignette')).toBe(true);
      expect(isWired('grain')).toBe(true);
      expect(isWired('colorGrade')).toBe(true);
      expect(isWired('hsl')).toBe(true);
      expect(isWired('crop')).toBe(false);
      expect(isWired('presets')).toBe(true);

      for (const tool of ALL_TOOLS) {
        expect(TOOLS_IN_GROUP[groupOf(tool)]).toContain(tool);
      }

      expect(defaultDisplayValue('exposure')).toBe(0);
      expect(defaultDisplayValue('temp')).toBe(6500);
      expect(defaultDisplayValue('sharpen')).toBe(40);
      expect(defaultDisplayValue('colorNR')).toBe(25);
    });
  });
});
