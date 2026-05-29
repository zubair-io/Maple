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
      const before = { ...lib.adjustmentFor(ID)() };
      svc.armTool('vignette');
      svc.setArmedDisplayValue(50);
      expect(lib.adjustmentFor(ID)()).toEqual(before);
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

  describe('tool catalog', () => {
    it('has 22 tools across 4 groups', () => {
      expect(ALL_TOOLS.length).toBe(22);
      expect(TOOLS_IN_GROUP.light.length).toBe(6);
      expect(TOOLS_IN_GROUP.color.length).toBe(5);
      expect(TOOLS_IN_GROUP.effects.length).toBe(6);
      expect(TOOLS_IN_GROUP.detail.length).toBe(5);
    });

    it('wires 16 of 22 tools in v0.1', () => {
      const wired = ALL_TOOLS.filter(isWired);
      expect(wired.length).toBe(16);
      for (const t of ['hsl', 'vignette', 'grain', 'splitTone', 'crop', 'presets'] as const) {
        expect(isWired(t)).toBe(false);
      }
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
