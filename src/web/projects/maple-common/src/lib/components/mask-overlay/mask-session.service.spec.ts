// mask-session.service.spec.ts — the mask-editing session (#1541):
// selection, add/remove, undo boundaries, the arm hook.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';

import { MaskSessionService } from './mask-session.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub, type LibraryStub } from '../../editor/editor-state.test-helpers';
import { TOOLS_IN_GROUP, isWired } from '../../editor/tool-model';

describe('MaskSessionService (#1541)', () => {
  let lib: LibraryStub & { focusedAsset: ReturnType<typeof signal> };
  let editor: EditorStateService;
  let session: MaskSessionService;

  beforeEach(() => {
    const stub = makeLibraryStub();
    lib = Object.assign(stub, {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    }) as typeof lib;
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    // The undo ring is keyed on the editor's bound image, same as the
    // editor-state spec binds it.
    editor.imageId.set('asset-1');
    session = TestBed.inject(MaskSessionService);
  });

  const layers = () => lib.adjustmentFor('asset-1')().localAdjustments;

  it('mask is an unwired Detail tool the drag bar rejects', () => {
    expect(TOOLS_IN_GROUP.detail).toContain('mask');
    expect(isWired('mask')).toBe(false);
    editor.armTool('mask');
    expect(editor.armedToolAcceptsValueEdits()).toBe(false);
    expect(session.active()).toBe(true);
  });

  it('add selects the new layer and pushes one undo entry', () => {
    expect(session.selected()).toBeNull();
    expect(session.addLinear()).toBe(0);
    expect(session.selectedIndex()).toBe(0);
    expect(layers().length).toBe(1);
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    expect(layers()).toEqual([]);
    expect(session.selected()).toBeNull();
  });

  it('radial default uses the image aspect', () => {
    session.addRadial();
    const mask = session.selected()!.mask;
    // radii.y is pre-corrected by the image aspect (w/h = 1.5) so the
    // default reads as a circle on screen.
    expect(mask.kind === 'radial' && mask.radii.y / mask.radii.x).toBeCloseTo(1.5, 12);
  });

  it('remove moves selection to the nearest survivor', () => {
    session.addLinear();
    session.addRadial();
    session.addLinear();
    session.select(2);
    session.remove(2);
    expect(session.selectedIndex()).toBe(1);
    session.removeSelected();
    expect(session.selectedIndex()).toBe(0);
    session.removeSelected();
    expect(session.selectedIndex()).toBeNull();
    expect(layers()).toEqual([]);
  });

  it('select rejects an out-of-range index', () => {
    session.addLinear();
    session.select(5);
    expect(session.selectedIndex()).toBeNull();
    session.select(0);
    expect(session.selectedIndex()).toBe(0);
  });

  it('continuous edits share one undo entry per gesture', () => {
    session.addLinear();
    session.setAdjustment('exposure', 0.25);
    session.setAdjustment('exposure', 0.5);
    session.setAdjustment('exposure', 0.75);
    session.endGesture();
    expect(session.adjustment('exposure')).toBe(0.75);
    editor.undo();
    expect(session.selected()!.adjustments.exposure).toBeUndefined();
    expect(layers().length).toBe(1);
  });

  it('discrete edits commit their own entry', () => {
    session.addRadial();
    session.setInverted(true);
    expect(session.selected()!.mask).toMatchObject({ kind: 'radial', invert: true });
    session.setAdjustment('contrast', 20);
    session.endGesture();
    session.resetAdjustments();
    expect(session.selected()!.adjustments).toEqual({});
    editor.undo();
    expect(session.adjustment('contrast')).toBe(20);
    editor.undo();
    expect(session.selected()!.adjustments.contrast).toBeUndefined();
    editor.undo();
    expect(session.selected()!.mask).toMatchObject({ kind: 'radial', invert: false });
  });

  it('feather is clamped and invert is a no-op on a linear layer', () => {
    session.addLinear();
    session.setFeather(1.7);
    session.endGesture();
    session.setInverted(true);
    expect(session.selected()!.mask).toMatchObject({ kind: 'linear', feather: 1 });
    // The no-op invert pushed no undo entry: one undo reverts the feather.
    editor.undo();
    expect(session.selected()!.mask).toMatchObject({ kind: 'linear', feather: 0.5 });
  });

  it('disarming mid-gesture closes it so the next drag gets its own undo entry', () => {
    session.addLinear();
    editor.armTool('mask');
    session.setAdjustment('exposure', 0.5);
    editor.armTool('exposure');
    TestBed.flushEffects();
    editor.armTool('mask');
    session.setAdjustment('exposure', 1);
    session.endGesture();
    editor.undo();
    expect(session.adjustment('exposure')).toBe(0.5);
  });

  it('arming Mask lands on the first layer when nothing is selected', () => {
    lib.updateAdjustment('asset-1', {
      localAdjustments: [
        {
          mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, feather: 0.5 },
          adjustments: {},
        },
      ],
    });
    editor.armTool('mask');
    TestBed.flushEffects();
    expect(session.selectedIndex()).toBe(0);
  });
});
