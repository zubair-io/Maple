import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { ASSET_ID, makeFixture } from './lens-corrections-panel.test-support';

const sliders = [
  ['Distortion', 'distortion', 'lensCorrectionDistortion'],
  ['Ca', 'ca', 'lensCorrectionCa'],
  ['Vignetting', 'vignetting', 'lensCorrectionVignetting'],
] as const;

for (const [suffix, display, field] of sliders) {
  describe(`${field} asset-bound gestures (#4103)`, () => {
    const start = `on${suffix}DragStart` as const;
    const change = `on${suffix}Change` as const;
    const end = `on${suffix}DragEnd` as const;
    const reset = `on${suffix}Reset` as const;

    for (const route of ['other', 'roundtrip', 'none'] as const) {
      it(`discards pending values and late ticks after ${route} focus`, () => {
        const { component, library } = makeFixture();
        const commit = vi.spyOn(TestBed.inject(EditorStateService), 'commit');
        component[start]();
        component[change](42);
        library.focusedAssetId.set(route === 'none' ? null : 'local-asset-2');
        if (route === 'roundtrip') library.focusedAssetId.set(ASSET_ID);
        // No render or signal read between selection changes.
        component[change](17);
        component[end]();
        expect(component[display]()).toBe(100);
        expect(library.updateAdjustment).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
      });
    }

    it('cannot start without focus or revive that gesture after focus returns', () => {
      const { component, library } = makeFixture();
      library.focusedAssetId.set(null);
      component[start]();
      library.focusedAssetId.set(ASSET_ID);
      component[change](42);
      component[end]();
      expect(library.updateAdjustment).not.toHaveBeenCalled();
    });

    it('reset discards the pending gesture and later release', () => {
      const { component, library } = makeFixture();
      const commit = vi.spyOn(TestBed.inject(EditorStateService), 'commit');
      component[start]();
      component[change](42);
      component[reset]();
      component[change](17);
      component[end]();
      expect(library.updateAdjustment).toHaveBeenCalledExactlyOnceWith(ASSET_ID, { [field]: 100 });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(component[display]()).toBe(100);
    });

    it('commits only the final value once to the starting photo', () => {
      const { component, library } = makeFixture();
      const commit = vi.spyOn(TestBed.inject(EditorStateService), 'commit');
      component[start]();
      component[change](42);
      component[change](17);
      expect(component[display]()).toBe(17);
      expect(commit).not.toHaveBeenCalled();
      component[end]();
      component[end]();
      expect(library.updateAdjustment).toHaveBeenCalledExactlyOnceWith(ASSET_ID, { [field]: 17 });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('wires actual slider gesture outputs to the ownership boundary', () => {
      const { fixture, component, library } = makeFixture();
      const index = sliders.findIndex((entry) => entry[2] === field);
      const slider = fixture.debugElement.queryAll(By.directive(MuiLivingSliderComponent))[index]
        .componentInstance as MuiLivingSliderComponent;
      slider.dragStart.emit();
      slider.value.set(42);
      expect(component[display]()).toBe(42);
      slider.dragEnd.emit();
      expect(library.updateAdjustment).toHaveBeenCalledExactlyOnceWith(ASSET_ID, { [field]: 42 });
    });
  });
}
