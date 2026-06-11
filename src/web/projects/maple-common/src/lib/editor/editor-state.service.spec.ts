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
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

// Minimal LibraryStateService stand-in: holds the AdjustmentModel
// signal, exposes `adjustmentFor`, and applies `updateAdjustment` patches
// in place (mirroring the real store's behavior without standing up the
// API + sidecar machinery).
class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

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
      // The stub tools are HSL / Crop plus vignette / grain / splitTone —
      // the latter three were re-gated at #952 because they had
      // AdjustmentModel fields but no pipeline apply code.
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

    it('rejects writes to the gated S5 effects tools (#952)', () => {
      // vignette / grain / splitTone present in the pill row but must not
      // write XMP — no apply code exists yet (#664 / #665 / #666). A drag
      // must leave the model (incl. the satellite fields) untouched.
      const before = { ...lib.adjustmentFor(ID)() };

      svc.armTool('vignette');
      svc.setArmedDisplayValue(-50);
      svc.armTool('grain');
      svc.setArmedDisplayValue(40);
      svc.armTool('splitTone');
      svc.setArmedDisplayValue(25);

      const after = lib.adjustmentFor(ID)();
      expect(after).toEqual(before);
      expect(after.vignetteAmount).toBe(0);
      expect(after.grainAmount).toBe(0);
      expect(after.splitToneBalance).toBe(0);
    });

    it('surfaces no misleading chip value for the gated S5 effects (#952)', () => {
      // The value chip reads `armedDisplayValue`. Grain is nominally 0..100,
      // so before the gate it mapped internal 0 → display 50 and the chip
      // showed a phantom "50". Gated tools must read 0 like hsl / crop /
      // presets — confirm all three.
      for (const tool of ['vignette', 'grain', 'splitTone'] as const) {
        svc.armTool(tool);
        expect(svc.armedDisplayValue()).toBe(0);
      }
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

  describe('tool catalog', () => {
    it('has 22 tools across 4 groups', () => {
      expect(ALL_TOOLS.length).toBe(22);
      expect(TOOLS_IN_GROUP.light.length).toBe(6);
      expect(TOOLS_IN_GROUP.color.length).toBe(5);
      expect(TOOLS_IN_GROUP.effects.length).toBe(6);
      expect(TOOLS_IN_GROUP.detail.length).toBe(5);
    });

    it('wires 17 of 22 tools (#952 re-gated vignette / grain / splitTone)', () => {
      const wired = ALL_TOOLS.filter(isWired);
      expect(wired.length).toBe(17);
      // vignette / grain / splitTone have AdjustmentModel fields but no
      // pipeline apply code, so they are stubs until #664 / #665 / #666.
      for (const t of ['hsl', 'vignette', 'grain', 'splitTone', 'crop'] as const) {
        expect(isWired(t)).toBe(false);
      }
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
