import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { GeometryPanelComponent } from './geometry-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

async function setup() {
  const focusedAssetId = signal<string | undefined>('photo');
  const model = signal(defaultAdjustmentModel());
  const updateAdjustment = vi.fn((_id, patch) => model.update((m) => ({ ...m, ...patch })));
  const commit = vi.fn();
  await TestBed.configureTestingModule({
    imports: [GeometryPanelComponent],
    providers: [
      {
        provide: LibraryStateService,
        useValue: { focusedAssetId, adjustmentFor: () => model, updateAdjustment },
      },
      { provide: EditorStateService, useValue: { commit } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(GeometryPanelComponent);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    model,
    commit,
    updateAdjustment,
    focusedAssetId,
  };
}

describe('manual geometry', () => {
  it('exposes five controls independent of optical profile support', async () => {
    const { fixture } = await setup();
    expect(fixture.nativeElement.querySelectorAll('mui-living-slider').length).toBe(5);
  });
  it('captures undo before a gesture and updates live without repeated snapshots', async () => {
    const { component, commit, model, updateAdjustment } = await setup();
    component.begin();
    component.change('geoRotation', 2);
    component.change('geoRotation', 4);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      updateAdjustment.mock.invocationCallOrder[0],
    );
    expect(model().geoRotation).toBe(4);
  });
  it('resets scale to one and rejects nonfinite writes or absent assets', async () => {
    const { component, model, updateAdjustment, focusedAssetId } = await setup();
    component.change('geoScale', 2);
    component.reset('geoScale', 1);
    expect(model().geoScale).toBe(1);
    updateAdjustment.mockClear();
    component.change('geoScale', Number.NaN);
    focusedAssetId.set(undefined);
    component.change('geoScale', 2);
    expect(updateAdjustment).not.toHaveBeenCalled();
  });
});
