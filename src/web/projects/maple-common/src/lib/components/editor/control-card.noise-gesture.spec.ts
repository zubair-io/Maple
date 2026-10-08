// Deferred Noise panel arming (#4352, #4414): the Noise slider's own card must
// survive its gesture, and the panel opens only after a changed gesture whose
// asset, tool selection and card are all still current.

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';

import { ControlCardComponent } from './control-card.component';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

function render() {
  TestBed.resetTestingModule();
  const focusedAssetId = signal<string | null>('asset-1');
  const capabilities = new LensCorrectionCapabilities();
  const updateAdjustment = vi.fn();
  const editorState = {
    commit: vi.fn(),
    haptic: vi.fn(),
    armedTool: vi.fn(() => 'sharpen'),
    armTool: vi.fn(),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    toolArmCount: 0,
  };
  TestBed.configureTestingModule({
    imports: [ControlCardComponent],
    providers: [
      { provide: EditorStateService, useValue: editorState },
      {
        provide: LibraryStateService,
        useValue: {
          focusedAssetId,
          adjustmentFor: vi.fn(() => signal(defaultAdjustmentModel())),
          updateAdjustment,
          lensCorrectionsFor: capabilities.for.bind(capabilities),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ControlCardComponent);
  fixture.componentRef.setInput('activeGroup', 'detail');
  fixture.detectChanges();
  return {
    fixture,
    card: fixture.componentInstance,
    editorState,
    updateAdjustment,
    focusedAssetId,
  };
}

describe('ControlCardComponent — deferred Noise panel arming (#4352, #4414)', () => {
  it('keeps the captured Noise slider through its drag and arms the panel after release', async () => {
    const { fixture, editorState, updateAdjustment } = render();
    const noise = fixture.debugElement
      .queryAll(By.directive(MuiLivingSliderComponent))
      .map((el) => el.componentInstance as MuiLivingSliderComponent)
      .find((slider) => slider.label() === 'Noise')!;
    noise.dragStart.emit();
    noise.value.set(2);
    noise.value.set(100);
    expect(editorState.armTool).not.toHaveBeenCalled();
    expect(updateAdjustment).toHaveBeenCalledTimes(2);
    expect(updateAdjustment).toHaveBeenLastCalledWith(
      'asset-1',
      expect.objectContaining({ nrLuminance: 100 }),
    );
    noise.dragEnd.emit();
    await Promise.resolve();
    expect(editorState.armTool).toHaveBeenCalledExactlyOnceWith('noise');
    expect(editorState.commit).toHaveBeenCalledTimes(1);
    expect(editorState.endGesture).toHaveBeenCalledTimes(1);
  });

  it('does not open Noise on a click or reset without a value-change tick', async () => {
    const { card, editorState } = render();
    card.onSliderDragStart('noise');
    card.onSliderDragEnd('noise');
    card.onSliderReset('noise');
    await Promise.resolve();
    expect(editorState.armTool).not.toHaveBeenCalled();
  });

  it('waits for the Noise gesture itself when another slider is released first', async () => {
    const { card, editorState } = render();
    card.onSliderDragStart('noise');
    card.onSliderDragStart('sharpen');
    card.onSliderChange('noise', 2);
    card.onSliderDragEnd('sharpen');
    await Promise.resolve();
    expect(editorState.armTool).not.toHaveBeenCalled();
    card.onSliderDragEnd('noise');
    await Promise.resolve();
    expect(editorState.armTool).toHaveBeenCalledExactlyOnceWith('noise');
  });

  it('does not unmount a slider still being dragged when Noise is released first', async () => {
    const { card, editorState } = render();
    card.onSliderDragStart('noise');
    card.onSliderDragStart('sharpen');
    card.onSliderChange('noise', 2);
    card.onSliderDragEnd('noise');
    await Promise.resolve();
    expect(editorState.armTool).not.toHaveBeenCalled();
  });

  it.each([
    ['another tool was chosen mid-gesture, even back to the starting tool', 'tool'],
    ['the focused asset changed', 'asset'],
    ['a panel opened and removed the card', 'panel'],
  ])('does not arm a deferred Noise panel when %s', async (_, change) => {
    const { fixture, card, editorState, focusedAssetId } = render();
    card.onSliderDragStart('noise');
    card.onSliderChange('noise', 2);
    if (change === 'tool') editorState.toolArmCount += 2;
    if (change === 'asset') focusedAssetId.set('asset-2');
    card.onSliderDragEnd('noise');
    if (change === 'panel') fixture.destroy();
    await Promise.resolve();
    expect(editorState.armTool).not.toHaveBeenCalled();
  });
});
