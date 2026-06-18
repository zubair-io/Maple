// editor-state.service.spec.ts — responsive-program S5c (#625).
//
// Mirror of Apple's EditorStateTests. Covers arming, value pipe,
// commit/undo/redo ring (cap 32), reset semantics, stub-tool no-op,
// and the wired-vs-stub catalog math.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';

import { EditorStateService, UNDO_STACK_CAP } from './editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { ALL_TOOLS, TOOLS_IN_GROUP, defaultDisplayValue, groupOf, isWired } from './tool-model';
import {
  defaultAdjustmentModel,
  defaultGeneratedAdjustmentModel,
  type AdjustmentModel,
} from '../models/adjustment-model';

// Minimal LibraryStateService stand-in: holds the AdjustmentModel
// signal, exposes `adjustmentFor`, and applies `updateAdjustment` patches
// in place (mirroring the real store's behavior without standing up the
// API + sidecar machinery).
class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
  private asShot = new Map<string, { temperature: number; tint: number }>();

  ensure(id: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, signal(defaultAdjustmentModel()));
    }
  }

  adjustmentFor(id: string): Signal<AdjustmentModel> {
    this.ensure(id);
    return this.models.get(id)!.asReadonly();
  }

  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void {
    this.ensure(id);
    this.models.get(id)!.update((m) => ({ ...m, ...patch }));
  }

  /** Test seam: stage a camera As-Shot reading for `id`. */
  setAsShot(id: string, wb: { temperature: number; tint: number }): void {
    this.asShot.set(id, wb);
  }

  asShotWbFor(id: string): { temperature: number; tint: number } | undefined {
    return this.asShot.get(id);
  }
}

describe('EditorStateService', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  const ID = 'asset-1';

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
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
      // The stub tools are HSL / Crop (pending their own specs). The S5
      // effects all left the #952 stub list (#1109 / #1110 / #1111).
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
      // A field-less reset must not push junk undo entries either.
      expect(svc.canUndo()).toBe(false);
    });

    it('splitTone is wired (#1111): drags write balance, sub-params write hue/sat', () => {
      svc.armTool('splitTone');
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
      // The feather sub-param routes through the same value pipe.
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
      // The sibling sub-param is untouched.
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
      svc.setArmedDisplayValue(80); // luminance = 80
      svc.armSubParam('color');
      svc.setArmedDisplayValue(90); // color = 90
      svc.resetArmedTool();
      const adj = lib.adjustmentFor(ID)();
      expect(adj.nrColor).toBe(25); // canonical nrColor default
      expect(adj.nrLuminance).toBe(80); // sibling untouched
    });

    it('remembers the armed sub-param per tool for the session (across tool switches and binds)', () => {
      svc.armTool('noise');
      svc.armSubParam('color');
      svc.armTool('exposure');
      svc.armTool('noise');
      expect(svc.armedSubParamId()).toBe('color');

      // bind() (image switch) keeps the session selection too.
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
      svc.armTool('vignette'); // wired at #1109
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('grain'); // wired at #1110
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('splitTone'); // wired at #1111
      expect(svc.armedToolAcceptsValueEdits()).toBe(true);
      svc.armTool('hsl'); // wired at #1112 — multi-param, sub-param chip routes edits
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
      // After 32 undos the oldest snapshot remaining is the commit just
      // before #9's setValue ran → exposure 0.08.
      expect(lib.adjustmentFor(ID)().exposure).toBeCloseTo(0.08, 9);
      expect(svc.canUndo()).toBe(false);
      svc.undo(); // no-op past cap
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

    it('resetArmedTool returns Color NR to its canonical 25 default', () => {
      svc.armTool('colorNR');
      svc.setArmedDisplayValue(80);
      svc.resetArmedTool();
      // Default is 25, NOT 0. Routing reset through `defaultDisplayValue`
      // keeps a fresh asset reading as "unmodified" after reset.
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
      // Sparse merge: untouched fields keep their current values.
      expect(after.exposure).toBeCloseTo(1.5, 9);

      // ONE undo entry: a single undo restores the full pre-apply state.
      svc.undo();
      const undone = lib.adjustmentFor(ID)();
      expect(undone.contrast).toBe(0);
      expect(undone.saturation).toBe(0);
      expect(undone.exposure).toBeCloseTo(1.5, 9);

      // Redo replays the whole preset in one step.
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
      expect(after.toneCurveMode).toBe('PerChannel'); // unchanged default
    });

    it('returns false and pushes no undo entry when nothing applies', () => {
      // Unknown-only preset → empty patch.
      expect(svc.applyPreset(preset({ future_only: 1 }))).toBe(false);
      expect(svc.canUndo()).toBe(false);

      // No bound image.
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
      // Every generated (raw-core) field is back to default, EXCEPT the WB
      // pair (→ As-Shot) and profile (→ Auto, which is already the default).
      for (const k of Object.keys(gd) as Array<keyof typeof gd>) {
        if (k === 'temperature' || k === 'tint') continue;
        expect(after[k as keyof AdjustmentModel]).toEqual(gd[k]);
      }
      expect(after.contrast).toBe(0);
      expect(after.saturation).toBe(0);
      expect(after.sharpenAmount).toBe(40);

      // ONE undo entry restores the full pre-reset state.
      expect(svc.canUndo()).toBe(true);
      svc.undo();
      expect(lib.adjustmentFor(ID)()).toEqual(before);
    });

    it('points white balance at the camera As-Shot reading and profile at Auto', () => {
      dirty();
      lib.setAsShot(ID, { temperature: 5200, tint: 7 });

      svc.resetAll();

      const after = lib.adjustmentFor(ID)();
      expect(after.temperature).toBe(5200);
      expect(after.tint).toBe(7);
      expect(after.whiteBalancePreset).toBe('As Shot');
      expect(after.profile).toBe('Auto');
    });

    it('preserves crop / rotation (RESET leaves geometry untouched)', () => {
      dirty();
      svc.resetAll();
      expect(lib.adjustmentFor(ID)().crop).toEqual(dirtyCrop);
    });

    it('falls back to the 6500 K / 0 default when no As-Shot value was captured', () => {
      dirty();
      svc.resetAll();
      const after = lib.adjustmentFor(ID)();
      expect(after.temperature).toBe(6500);
      expect(after.tint).toBe(0);
      expect(after.profile).toBe('Auto');
    });

    it('returns false and pushes no undo entry when no image is bound', () => {
      svc.imageId.set(null);
      expect(svc.resetAll()).toBe(false);
      expect(svc.canUndo()).toBe(false);
    });
  });

  describe('tool catalog', () => {
    it('has 23 tools across 4 groups (Light gained Brightness, #1108)', () => {
      expect(ALL_TOOLS.length).toBe(23);
      expect(TOOLS_IN_GROUP.light.length).toBe(7);
      expect(TOOLS_IN_GROUP.color.length).toBe(5);
      expect(TOOLS_IN_GROUP.effects.length).toBe(6);
      expect(TOOLS_IN_GROUP.detail.length).toBe(5);
    });

    it('wires 22 of 23 tools (S5 effects un-stubbed at #1109/#1110/#1111, HSL at #1112)', () => {
      const wired = ALL_TOOLS.filter(isWired);
      expect(wired.length).toBe(22);
      expect(isWired('vignette')).toBe(true);
      expect(isWired('grain')).toBe(true);
      expect(isWired('splitTone')).toBe(true);
      // HSL left the stub list at #1112 — wired with 24 sub-params (no primary drag-bar field).
      expect(isWired('hsl')).toBe(true);
      expect(isWired('crop')).toBe(false);
      // presets left STUB_TOOLS at #1115 — wired, but value-less.
      expect(isWired('presets')).toBe(true);
    });

    it('groupOf round-trips through TOOLS_IN_GROUP', () => {
      for (const tool of ALL_TOOLS) {
        const g = groupOf(tool);
        expect(TOOLS_IN_GROUP[g]).toContain(tool);
      }
    });

    it('exposes a default display value per tool', () => {
      expect(defaultDisplayValue('exposure')).toBe(0);
      expect(defaultDisplayValue('temp')).toBe(6500);
      expect(defaultDisplayValue('sharpen')).toBe(40);
      // Color NR defaults to 25 per the generated AdjustmentModel.
      expect(defaultDisplayValue('colorNR')).toBe(25);
    });
  });
});
