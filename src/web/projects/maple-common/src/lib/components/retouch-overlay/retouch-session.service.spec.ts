// retouch-session.service.spec.ts — the clone / heal session (#3409):
// placement, selection, undo boundaries, the decode-scope invalidation.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';

import { RetouchSessionService } from './retouch-session.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub, type LibraryStub } from '../../editor/editor-state.test-helpers';
import { TOOLS_IN_GROUP, isWired } from '../../editor/tool-model';

describe('RetouchSessionService (#3409)', () => {
  let lib: LibraryStub & { focusedAsset: ReturnType<typeof signal> };
  let editor: EditorStateService;
  let session: RetouchSessionService;

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
    editor.imageId.set('asset-1');
    session = TestBed.inject(RetouchSessionService);
  });

  const spots = () => lib.adjustmentFor('asset-1')().retouchSpots;

  it('heal is an unwired Detail tool the drag bar rejects', () => {
    expect(TOOLS_IN_GROUP.detail).toContain('heal');
    expect(isWired('heal')).toBe(false);
    editor.armTool('heal');
    expect(editor.armedToolAcceptsValueEdits()).toBe(false);
    expect(session.active()).toBe(true);
  });

  it('placing a spot selects it, seeds a source, and pushes one undo entry', () => {
    expect(session.selected()).toBeNull();
    expect(session.place({ x: 0.4, y: 0.6 })).toBe(0);
    expect(session.selectedIndex()).toBe(0);
    expect(spots().length).toBe(1);
    expect(spots()[0].center).toEqual({ x: 0.4, y: 0.6 });
    // The seeded source is offset, never on top of the destination — a spot
    // that samples itself renders nothing.
    expect(spots()[0].source.x).toBeGreaterThan(spots()[0].center.x);
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    expect(spots()).toEqual([]);
  });

  it('commits a repair-class transaction whose invalidation scope is decode', () => {
    session.place({ x: 0.4, y: 0.6 });
    editor.endEdit();
    const tx = editor.undoHistory().at(-1);
    expect(tx?.kind).toBe('repair');
    expect(tx?.invalidation).toBe('decode');
  });

  it('the brush seeds a new spot and rewrites the selected one', () => {
    session.setKind('clone');
    session.setRadius(0.08);
    session.setFeather(0.25);
    session.setOpacity(0.5);
    session.place({ x: 0.3, y: 0.3 });
    expect(spots()[0]).toMatchObject({
      kind: 'clone',
      radius: 0.08,
      feather: 0.25,
      opacity: 0.5,
    });
    session.setOpacity(0.9);
    expect(spots()[0].opacity).toBe(0.9);
  });

  it('selecting a spot loads its shape into the brush', () => {
    session.setRadius(0.03);
    session.place({ x: 0.2, y: 0.2 });
    // Deselect first: a brush change with a spot selected deliberately
    // rewrites that spot, which is the behaviour the test above pins.
    session.select(null);
    session.setRadius(0.09);
    session.place({ x: 0.7, y: 0.7 });
    expect(session.brushRadius()).toBe(0.09);
    session.select(0);
    expect(session.brushRadius()).toBe(0.03);
  });

  it('one continuous gesture is one undo entry', () => {
    session.place({ x: 0.4, y: 0.6 });
    editor.endEdit();
    const before = editor.undoHistory().length;
    const spot = spots()[0];
    session.setShape({ ...spot, source: { x: 0.9, y: 0.6 } });
    session.setShape({ ...spot, source: { x: 0.92, y: 0.6 } });
    session.endGesture();
    editor.endEdit();
    expect(editor.undoHistory().length).toBe(before + 1);
  });

  it('a redundant write pushes nothing onto the undo stack', () => {
    session.place({ x: 0.4, y: 0.6 });
    editor.endEdit();
    const before = editor.undoHistory().length;
    session.setShape({ ...spots()[0] });
    editor.endEdit();
    expect(editor.undoHistory().length).toBe(before);
  });

  it('delete keeps the selection in range; reset drops everything', () => {
    session.place({ x: 0.2, y: 0.2 });
    session.place({ x: 0.5, y: 0.5 });
    session.place({ x: 0.8, y: 0.8 });
    session.remove(2);
    expect(spots().length).toBe(2);
    expect(session.selectedIndex()).toBe(1);
    session.resetAll();
    expect(spots()).toEqual([]);
    expect(session.selectedIndex()).toBeNull();
  });
});
