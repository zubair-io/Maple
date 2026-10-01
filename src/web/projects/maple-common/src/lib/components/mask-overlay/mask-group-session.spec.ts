import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStateService } from '../../editor/editor-state.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { MaskGroup } from '../../models/local-adjustment';
import { MaskSessionService } from './mask-session.service';
import { defaultRadialMask } from './mask-geometry';

describe('mask-group authoring (#3408)', () => {
  let session: MaskSessionService;
  let editor: EditorStateService;

  beforeEach(() => {
    const library = Object.assign(makeLibraryStub(), {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: library },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.imageId.set('asset-1');
    session = TestBed.inject(MaskSessionService);
  });

  const group = (): MaskGroup => {
    const mask = session.selected()?.mask;
    if (mask?.kind !== 'group') throw new Error('Expected selected mask group');
    return mask;
  };

  it('wraps the existing mask, preserving correction values and range, as one undo step', () => {
    session.addRadial();
    session.setAdjustment('exposure', 0.7);
    session.endGesture();
    session.setRangeEnabled(true);
    session.updateSelected(true, (layer) => ({ ...layer, xmpGroupSlot: 9 }));
    const original = session.selected()!;
    session.addComponent('linear', 'subtract');
    expect(session.layers()).toHaveLength(1);
    expect(session.componentIndex()).toBe(1);
    expect(group().components[0]).toEqual({ mask: original.mask, combine: 'add', invert: false });
    expect(group().components[1]).toMatchObject({ combine: 'subtract', mask: { kind: 'linear' } });
    expect(session.selected()).toMatchObject({
      adjustments: original.adjustments,
      range: original.range,
      xmpGroupSlot: 9,
    });
    editor.undo();
    expect(session.selected()).toEqual(original);
    editor.redo();
    expect(group().components).toHaveLength(2);
  });

  it('edits only the selected component and gives shape drags one undo boundary', () => {
    session.addRadial();
    session.addComponent('linear', 'intersect');
    const original = group();
    session.setFeather(0.1);
    session.setFeather(0.2);
    session.endGesture();
    expect(group().components[0]).toEqual(original.components[0]);
    expect(session.selectedMask()).toMatchObject({ kind: 'linear', feather: 0.2 });
    editor.undo();
    expect(group()).toEqual(original);
    session.selectComponent(0);
    session.setShape({ ...defaultRadialMask(1.5), center: { x: 0.2, y: 0.3 } });
    session.endGesture();
    expect(group().components[1]).toEqual(original.components[1]);
    expect(group().components[0].mask).toMatchObject({ center: { x: 0.2, y: 0.3 } });
  });

  it('preserves selected component identity when an earlier component is removed', () => {
    session.addLinear();
    session.addComponent('radial', 'subtract');
    session.addComponent('linear', 'intersect');
    const selected = session.selectedMask();
    session.removeComponent(0);
    expect(session.componentIndex()).toBe(1);
    expect(session.selectedMask()).toEqual(selected);
    session.removeComponent(-1);
    expect(session.componentIndex()).toBe(1);
    session.removeComponent(1);
    expect(session.componentIndex()).toBe(0);
    session.removeComponent(0);
    expect(group().components).toHaveLength(1);
  });

  it('undoes component mode, component inversion and group inversion independently', () => {
    session.addLinear();
    session.addComponent('radial', 'subtract');
    const original = group();
    session.setComponentCombine('intersect');
    session.setComponentInverted(true);
    session.setGroupInverted(true);
    expect(group()).toMatchObject({
      invert: true,
      components: [{ invert: false }, { combine: 'intersect', invert: true }],
    });
    editor.undo();
    expect(group().invert).toBe(false);
    editor.undo();
    expect(group().components[1].invert).toBe(false);
    editor.undo();
    expect(group()).toEqual(original);
  });

  it('makes opacity a clamped continuous gesture and rejects non-finite values', () => {
    session.addLinear();
    const original = session.selected();
    session.setOpacity(1);
    expect(session.selected()).toEqual(original);
    session.setOpacity(0.5);
    session.setOpacity(0.25);
    session.setOpacity(Number.NaN);
    session.endGesture();
    expect(group().opacity).toBe(0.25);
    editor.undo();
    expect(session.selected()).toEqual(original);
    session.setOpacity(-1);
    expect(group().opacity).toBe(0);
    session.setOpacity(2);
    expect(group().opacity).toBe(1);
  });

  it('resets component selection when switching layers', () => {
    session.addLinear();
    session.addComponent('radial', 'subtract');
    session.addRadial();
    session.addComponent('linear', 'intersect');
    session.select(0);
    expect(session.componentIndex()).toBe(0);
    expect(session.selectedMask()?.kind).toBe('linear');
    session.selectComponent(1);
    session.select(1);
    expect(session.componentIndex()).toBe(0);
    expect(session.selectedMask()?.kind).toBe('radial');
  });
});
