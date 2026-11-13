import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ControlCardComponent } from './control-card.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { subParamsFor } from '../../editor/tool-sub-param';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { LibraryStateService } from '../../state/library-state.service';

describe('ControlCardComponent Color reset', () => {
  it('resets every HSL and B&W mixer field with one undo boundary', () => {
    const adjustment = defaultAdjustmentModel();
    adjustment.hueAdjustmentRed = 25;
    adjustment.saturationAdjustmentGreen = -12;
    adjustment.luminanceAdjustmentMagenta = 40;
    adjustment.grayMixerBlue = 33;
    const capabilities = new LensCorrectionCapabilities();
    const updateAdjustment = vi.fn();
    const commit = vi.fn();
    TestBed.configureTestingModule({
      imports: [ControlCardComponent],
      providers: [
        {
          provide: EditorStateService,
          useValue: {
            commit,
            haptic: vi.fn(),
            armedTool: vi.fn(() => 'brightness'),
            armTool: vi.fn(),
            beginGesture: vi.fn(),
            endGesture: vi.fn(),
          },
        },
        {
          provide: LibraryStateService,
          useValue: {
            focusedAssetId: signal<string | null>('asset-1'),
            adjustmentFor: vi.fn(() => signal(adjustment)),
            updateAdjustment,
            lensCorrectionsFor: capabilities.for.bind(capabilities),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ControlCardComponent);
    fixture.componentRef.setInput('activeGroup', 'color');
    fixture.detectChanges();

    fixture.componentInstance.resetGroup();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(updateAdjustment).toHaveBeenCalledTimes(1);
    const patch: AdjustmentModel = updateAdjustment.mock.lastCall?.[1];
    const defaults = defaultAdjustmentModel();
    for (const tool of ['hsl', 'bwMix'] as const) {
      for (const sub of subParamsFor(tool)) {
        expect(patch[sub.field]).toBe(defaults[sub.field]);
      }
    }
  });
});
