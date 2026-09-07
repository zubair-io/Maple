// GeometryPanelComponent spec (#3410).
//
// What is worth pinning here is the contract the panel owes the rest of the
// editor, not its markup: the seven sliders come from the generated schema,
// each writes its own field, a drag is ONE undo entry, and a double-click
// restores the value that makes that factor the identity.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GeometryPanelComponent,
  GEOMETRY_SLIDERS,
  type GeometryField,
} from './geometry-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { ADJUSTMENT_RANGES, defaultAdjustmentModel } from '../../models/adjustment-model';
import { signal } from '@angular/core';

const DEFAULTS = defaultAdjustmentModel();

function harness(focusedAssetId: string | null = 'asset-1') {
  const model = signal({ ...DEFAULTS });
  const updateAdjustment = vi.fn((_id: string, patch: Record<string, unknown>) => {
    model.set({ ...model(), ...patch } as typeof DEFAULTS);
  });
  const library = {
    focusedAssetId: () => focusedAssetId,
    adjustmentFor: () => model,
    updateAdjustment,
  };
  const commit = vi.fn();
  const beginGesture = vi.fn();
  const endGesture = vi.fn();
  const editorState = { commit, beginGesture, endGesture };

  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryStateService, useValue: library },
      { provide: EditorStateService, useValue: editorState },
    ],
  });
  const fixture = TestBed.createComponent(GeometryPanelComponent);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    updateAdjustment,
    commit,
    beginGesture,
    endGesture,
    model,
  };
}

describe('GeometryPanelComponent (#3410)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('presents the seven manual-geometry sliders in panel order', () => {
    expect(GEOMETRY_SLIDERS.map((s) => s.field)).toEqual([
      'perspectiveVertical',
      'perspectiveHorizontal',
      'perspectiveRotate',
      'perspectiveScale',
      'perspectiveAspect',
      'perspectiveX',
      'perspectiveY',
    ]);
  });

  /// Bounds come from the generated table, never from numbers typed here, so
  /// a schema change moves the panel with it.
  it('takes every bound from the generated schema', () => {
    for (const s of GEOMETRY_SLIDERS) {
      expect([s.min, s.max]).toEqual([...ADJUSTMENT_RANGES[s.field]]);
    }
  });

  /// Scale's default (100) is the identity, not the midpoint of a symmetric
  /// range, so it must not draw the centre notch the other six do.
  it('draws the centre notch on the six bipolar sliders but not on Scale', () => {
    const scale = GEOMETRY_SLIDERS.find((s) => s.field === 'perspectiveScale');
    expect(scale?.bipolar).toBe(false);
    expect(GEOMETRY_SLIDERS.filter((s) => s.bipolar)).toHaveLength(6);
  });

  it('writes each slider to its own field', () => {
    const { component, model } = harness();
    GEOMETRY_SLIDERS.forEach((s, index) => {
      component.onValueChange(s.field, index + 1);
    });
    const written = GEOMETRY_SLIDERS.map((s) => model()[s.field]);
    expect(written).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  /// The gesture contract: one transaction opened on pointer-down and closed
  /// on release, regardless of how many ticks the drag produced.
  it('lands a whole drag as one undo entry', () => {
    const { component, commit, beginGesture, endGesture, updateAdjustment } = harness();
    component.onDragStart();
    for (const v of [-5, -12, -20, -31]) {
      component.onValueChange('perspectiveVertical', v);
    }
    component.onDragEnd();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(beginGesture).toHaveBeenCalledTimes(1);
    expect(endGesture).toHaveBeenCalledTimes(1);
    expect(updateAdjustment).toHaveBeenCalledTimes(4);
  });

  it('resets a slider to the value that makes its factor the identity', () => {
    const { component, model, commit } = harness();
    component.onValueChange('perspectiveScale', 130);
    expect(model().perspectiveScale).toBe(130);
    component.onReset('perspectiveScale');
    expect(model().perspectiveScale).toBe(100);
    expect(commit).toHaveBeenCalled();
  });

  /// Every default must be the identity value, or a reset would leave the
  /// frame warped.
  it('resets every slider to a neutral homography', () => {
    const { component, model } = harness();
    for (const s of GEOMETRY_SLIDERS) {
      component.onValueChange(s.field, 42);
      component.onReset(s.field);
    }
    for (const s of GEOMETRY_SLIDERS) {
      expect(model()[s.field]).toBe(DEFAULTS[s.field as GeometryField]);
    }
  });

  it('refuses writes and disables itself with no focused asset', () => {
    const { component, updateAdjustment, commit } = harness(null);
    expect(component.panelDisabled()).toBe(true);
    component.onDragStart();
    component.onValueChange('perspectiveVertical', -20);
    component.onReset('perspectiveVertical');
    expect(updateAdjustment).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
