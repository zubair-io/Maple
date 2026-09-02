// LensCorrectionsPanelComponent — unit tests (#2231).
//
// Strategy mirrors `film-panel.component.spec.ts`: stub `LibraryStateService`
// with a writable `focusedAssetId` signal and a per-asset adjustment-model
// map. Asserts the toggle reflects/writes `lensProfileEnable`, each slider
// reflects the model's committed value when idle, tracks a LOCAL live value
// during a drag without writing the model per tick, and writes exactly once
// — on `dragEnd` — with the final value (the decode-product commit-on-
// release contract, #376 / spec § 3.1-3.2).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { signal } from '@angular/core';

import { LensCorrectionsPanelComponent } from './lens-corrections-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

const ASSET_ID = 'local-asset-1';

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(ASSET_ID);
  private readonly models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

  private modelFor(id: string) {
    const existing = this.models.get(id);
    if (existing) return existing;
    const created = signal<AdjustmentModel>({ ...defaultAdjustmentModel() });
    this.models.set(id, created);
    return created;
  }

  adjustmentFor = vi.fn((id: string) => this.modelFor(id));

  updateAdjustment = vi.fn((id: string, patch: Partial<AdjustmentModel>) => {
    this.modelFor(id).update((m) => ({ ...m, ...patch }));
  });
}

function makeFixture() {
  const library = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [LensCorrectionsPanelComponent],
    providers: [{ provide: LibraryStateService, useValue: library }],
  });
  const fixture = TestBed.createComponent(LensCorrectionsPanelComponent);
  fixture.detectChanges();
  return { fixture, library, component: fixture.componentInstance };
}

describe('LensCorrectionsPanelComponent', () => {
  it('reflects lensProfileEnable ("On" default) via `enabled`', () => {
    const { component } = makeFixture();
    expect(component.enabled()).toBe(true);
  });

  it('toggling writes the opposite lensProfileEnable value', () => {
    const { component, library } = makeFixture();
    component.toggleEnabled();
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { lensProfileEnable: 'Off' });
    component.toggleEnabled();
    expect(library.updateAdjustment).toHaveBeenLastCalledWith(ASSET_ID, {
      lensProfileEnable: 'On',
    });
  });

  it('sliders default to 100 (the canonical model default) when idle', () => {
    const { component } = makeFixture();
    expect(component.distortion()).toBe(100);
    expect(component.ca()).toBe(100);
    expect(component.vignetting()).toBe(100);
  });

  it('a live drag tracks the LOCAL value without writing the model', () => {
    const { component, library } = makeFixture();
    component.onDistortionChange(42);
    expect(component.distortion()).toBe(42);
    expect(library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('dragEnd commits the parked value exactly once, then reverts to model-tracking', () => {
    const { component, library } = makeFixture();
    component.onDistortionChange(42);
    component.onDistortionDragEnd();
    expect(library.updateAdjustment).toHaveBeenCalledTimes(1);
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, {
      lensCorrectionDistortion: 42,
    });
    expect(component.distortion()).toBe(42); // now reads back from the committed model

    // A second drag with no change (dragEnd with nothing parked) must not
    // write again.
    component.onDistortionDragEnd();
    expect(library.updateAdjustment).toHaveBeenCalledTimes(1);
  });

  it('the three sliders write distinct fields independently', () => {
    const { component, library } = makeFixture();
    component.onCaChange(10);
    component.onCaDragEnd();
    component.onVignettingChange(20);
    component.onVignettingDragEnd();
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { lensCorrectionCa: 10 });
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, {
      lensCorrectionVignetting: 20,
    });
    expect(component.distortion()).toBe(100); // untouched
  });

  it('reset writes the canonical default (100) immediately, no drag needed', () => {
    const { component, library } = makeFixture();
    component.onCaReset();
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { lensCorrectionCa: 100 });
  });
});
