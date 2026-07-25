// editor-state.color-grade.spec.ts — the Color Grading tool's sub-param
// writes (#275). Split from `editor-state.service.spec.ts`, which sits
// exactly at the 600-line hard budget.
//
// The tool supersedes the old Split Tone pill, so its thirteen sub-params
// span BOTH field families: shadow/highlight hue+saturation and the
// balance still live on the `splitTone*` fields (ACR stores those in
// `crs:SplitToning*` even from its Color Grading panel), while the
// midtone zone, the per-zone luminances and the global wheel live on the
// `colorGrade*` fields.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { EditorStateService } from './editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { subParamsFor } from './tool-sub-param';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

/** Same minimal stand-in `editor-state.service.spec.ts` uses. */
class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

  private ensure(id: string): void {
    if (!this.models.has(id)) this.models.set(id, signal(defaultAdjustmentModel()));
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

const ID = 'asset-color-grade-1';

describe('EditorStateService — Color Grading sub-params (#275)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
    svc.armTool('colorGrade');
  });

  it('writes every wheel value through its armed sub-param', () => {
    const written: Record<string, number> = {
      shadowHue: 30,
      shadowSat: 60,
      shadowLum: 25,
      midtoneHue: 150,
      midtoneSat: 55,
      midtoneLum: -35,
      highlightHue: 210,
      highlightSat: 40,
      highlightLum: -20,
      globalHue: 180,
      globalSat: 15,
      globalLum: 10,
    };
    for (const [id, value] of Object.entries(written)) {
      svc.armSubParam(id);
      svc.setArmedDisplayValue(value);
    }

    const model = lib.adjustmentFor(ID)();
    const fieldOf = (id: string) => subParamsFor('colorGrade').find((s) => s.id === id)!.field;
    for (const [id, value] of Object.entries(written)) {
      expect(model[fieldOf(id)], `${id} → ${fieldOf(id)}`).toBe(value);
    }
  });

  it('keeps the balance on the tool-level drag bar', () => {
    svc.setArmedDisplayValue(25);
    expect(lib.adjustmentFor(ID)().splitToneBalance).toBe(25);
    // Editing a wheel afterwards must not disturb the balance.
    svc.armSubParam('midtoneSat');
    svc.setArmedDisplayValue(70);
    expect(lib.adjustmentFor(ID)().splitToneBalance).toBe(25);
    expect(lib.adjustmentFor(ID)().colorGradeMidtoneSaturation).toBe(70);
  });
});
