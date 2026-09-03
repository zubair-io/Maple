// EditorStateService's transaction ring (#2432): every committed action
// class is exactly one undo entry with a valid redo path, a no-op records
// nothing, preview ticks never enter history until committed, the open
// transaction closes at the next boundary, and assistive technology hears
// every committed / undone / redone change.
import { TestBed } from '@angular/core/testing';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorStateService } from './editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { type EditTransactionKind } from './edit-transaction';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';
import { makeLibraryStub, type LibraryStub } from './editor-state.test-helpers';

class AnnouncerStub {
  texts: string[] = [];
  announce(text: string): Promise<void> {
    this.texts.push(text);
    return Promise.resolve();
  }
}

class PipelineStub {
  computeAutoAdjustments(): Promise<AutoAdjustPatch> {
    return Promise.resolve({
      exposure: 0.8,
      temperature: 5000,
      tint: 0,
      contrast: 5,
      highlights: -10,
      shadows: 10,
      whites: -3,
      blacks: -4,
    });
  }
}

describe('EditorStateService transactions', () => {
  const ID = 'asset-1';
  let svc: EditorStateService;
  let lib: LibraryStub;
  let announcer: AnnouncerStub;

  beforeEach(() => {
    lib = makeLibraryStub();
    announcer = new AnnouncerStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: new PipelineStub() },
        { provide: LiveAnnouncer, useValue: announcer },
      ],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
  });

  const model = (): AdjustmentModel => lib.adjustmentFor(ID)();

  it('records exactly one undo entry with a valid redo path per action class', async () => {
    const actions: [string, EditTransactionKind, () => Promise<void> | void][] = [
      [
        'slider drag',
        'adjustment',
        () => {
          svc.armTool('exposure');
          svc.commit();
          svc.beginGesture();
          svc.setArmedDisplayValue(0.25);
          svc.setArmedDisplayValue(0.75);
          svc.endGesture();
        },
      ],
      [
        'reset armed tool',
        'reset',
        () => {
          svc.armTool('exposure');
          svc.resetArmedTool();
        },
      ],
      [
        'preset',
        'preset',
        () => void svc.applyPreset({ id: 'p', name: 'Punchy', fields: { contrast: 25 } } as never),
      ],
      ['black & white', 'adjustment', () => svc.setBlackWhite('On')],
      ['reset all', 'reset', () => void svc.resetAll()],
      ['auto', 'auto', () => svc.applyAuto(ID).then(() => undefined)],
      [
        'crop',
        'crop',
        () => {
          svc.commit('crop', 'Crop');
          lib.updateAdjustment(ID, {
            crop: { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0 },
          });
          svc.endEdit();
        },
      ],
    ];
    for (const [label, kind, act] of actions) {
      // Seed a non-default model so every reset has something to undo.
      svc.commit('adjustment', 'seed');
      lib.updateAdjustment(ID, { exposure: 1.5, contrast: 40, saturation: -20 });
      svc.endEdit();
      const before = model();
      const entries = svc.undoHistory().length;

      await act();

      const after = model();
      expect(after, `${label}: the action changed nothing`).not.toEqual(before);
      expect(svc.undoHistory().length, `${label}: exactly one undo entry`).toBe(entries + 1);
      const tx = svc.lastCommittedTransaction()!;
      expect(tx.kind, label).toBe(kind);
      expect(tx.before, label).toEqual(before);
      expect(tx.after, label).toEqual(after);
      expect(tx.diff.length, label).toBeGreaterThan(0);

      svc.undo();
      expect(model(), `${label}: undo restores before`).toEqual(before);
      expect(svc.canRedo(), label).toBe(true);
      svc.redo();
      expect(model(), `${label}: redo restores after`).toEqual(after);
      expect(svc.undoHistory().length, `${label}: redo re-records one entry`).toBe(entries + 1);
    }
  });

  it('records nothing for a commit that changes nothing', () => {
    svc.commit();
    svc.endEdit();
    expect(svc.undoHistory()).toEqual([]);
    expect(svc.canUndo()).toBe(false);
    expect(svc.lastCommittedTransaction()).toBeNull();
    expect(announcer.texts).toEqual([]);
  });

  it('keeps preview ticks out of history until committed', () => {
    lib.updateAdjustment(ID, { exposure: 0.2 });
    lib.updateAdjustment(ID, { exposure: 0.4 });
    expect(svc.canUndo()).toBe(false);
    expect(svc.undoHistory()).toEqual([]);
  });

  it('closes an open transaction at the next boundary', () => {
    svc.commit('adjustment', 'Exposure');
    lib.updateAdjustment(ID, { exposure: 0.3 });
    lib.updateAdjustment(ID, { exposure: 0.6 });
    expect(svc.canUndo()).toBe(true); // already moved the model…
    expect(svc.undoHistory()).toEqual([]); // …but not recorded yet
    svc.commit('adjustment', 'Contrast'); // next gesture closes it
    expect(svc.undoHistory().length).toBe(1);
    expect(svc.undoHistory()[0].after.exposure).toBe(0.6);
    lib.updateAdjustment(ID, { contrast: 20 });
    svc.undo(); // closes the contrast transaction, then pops it
    expect(model().contrast).toBe(0);
    expect(model().exposure).toBe(0.6);
    svc.undo();
    expect(model().exposure).toBe(0);
  });

  it('drops the open transaction on cancelEdit and keeps the preview value', () => {
    svc.commit();
    lib.updateAdjustment(ID, { exposure: 1 });
    svc.cancelEdit();
    expect(svc.canUndo()).toBe(false);
    expect(model().exposure).toBe(1);
  });

  it('assigns monotonic transaction ids', () => {
    for (let i = 1; i <= 3; i++) {
      svc.commit();
      lib.updateAdjustment(ID, { exposure: i });
      svc.endEdit();
    }
    expect(svc.undoHistory().map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('announces committed, undone and redone changes', () => {
    svc.armTool('contrast');
    svc.commit();
    svc.setArmedDisplayValue(30);
    svc.endGesture();
    svc.undo();
    svc.redo();
    expect(announcer.texts).toEqual(['Contrast', 'Undo Contrast', 'Redo Contrast']);
  });

  it('hands the committed state to the library as the sidecar state', () => {
    const calls: AdjustmentModel[] = [];
    const original = lib.updateAdjustment.bind(lib);
    lib.updateAdjustment = (id, patch) => {
      original(id, patch);
      if ('blackWhite' in patch && 'exposure' in patch) calls.push(patch as AdjustmentModel);
    };
    svc.commit('adjustment', 'Exposure');
    lib.updateAdjustment(ID, { exposure: 0.9 });
    svc.endEdit();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(svc.lastCommittedTransaction()!.after);
  });
});
