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
import type { LensCorrectionCapability } from '../../state/library-store-lens-corrections';
import { cameraSupportFromJson } from '../../state/camera-support';

const ASSET_ID = 'local-asset-1';

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(ASSET_ID);
  private readonly models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
  // #3182 — default every asset to "capable" (has corrections, CA live) so
  // every test written before this ticket keeps exercising the sliders
  // exactly as before; the dedicated describe block below overrides this
  // per-asset via `seedLensCorrections` to exercise the disabled states.
  private readonly capabilities = new Map<
    string,
    ReturnType<typeof signal<LensCorrectionCapability>>
  >();

  private modelFor(id: string) {
    const existing = this.models.get(id);
    if (existing) return existing;
    const created = signal<AdjustmentModel>({ ...defaultAdjustmentModel() });
    this.models.set(id, created);
    return created;
  }

  private capsFor(id: string) {
    const existing = this.capabilities.get(id);
    if (existing) return existing;
    const created = signal<LensCorrectionCapability>({
      hasLensCorrections: true,
      lensCorrectionCaInert: false,
    });
    this.capabilities.set(id, created);
    return created;
  }

  adjustmentFor = vi.fn((id: string) => this.modelFor(id));

  updateAdjustment = vi.fn((id: string, patch: Partial<AdjustmentModel>) => {
    this.modelFor(id).update((m) => ({ ...m, ...patch }));
  });

  lensCorrectionsFor = vi.fn((id: string) => this.capsFor(id)());

  seedLensCorrections = vi.fn(
    (id: string, hasLensCorrections: boolean, caInert: boolean, supportJson?: string) => {
      this.capsFor(id).set({
        hasLensCorrections,
        lensCorrectionCaInert: caInert,
        cameraSupport: cameraSupportFromJson(supportJson),
      });
    },
  );
}

async function makeFixture() {
  const library = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [LensCorrectionsPanelComponent],
    providers: [{ provide: LibraryStateService, useValue: library }],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(LensCorrectionsPanelComponent);
  fixture.detectChanges();
  return { fixture, library, component: fixture.componentInstance };
}

describe('LensCorrectionsPanelComponent', async () => {
  it('explains missing lens correction independently of the camera calibration', async () => {
    const { fixture, library } = await makeFixture();
    library.seedLensCorrections(
      ASSET_ID,
      false,
      true,
      JSON.stringify({
        cameraKey: 'Example',
        resolution: 'bundle_confident',
        lens: 'no_correction_data',
      }),
    );
    fixture.detectChanges();
    const support = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="lens-support"]',
    );
    expect(support?.textContent).toContain('No correction data');
    expect(support?.textContent).toContain('controls have nothing to apply');
    const controls = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="lens-corrections-panel"]',
    )!;
    expect(controls.classList.contains('opacity-[0.45]')).toBe(true);
    expect(controls.contains(support)).toBe(false);
  });
  it('reflects lensProfileEnable ("On" default) via `enabled`', async () => {
    const { component } = await makeFixture();
    expect(component.enabled()).toBe(true);
  });

  it('toggling writes the opposite lensProfileEnable value', async () => {
    const { component, library } = await makeFixture();
    component.toggleEnabled();
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { lensProfileEnable: 'Off' });
    component.toggleEnabled();
    expect(library.updateAdjustment).toHaveBeenLastCalledWith(ASSET_ID, {
      lensProfileEnable: 'On',
    });
  });

  it('sliders default to 100 (the canonical model default) when idle', async () => {
    const { component } = await makeFixture();
    expect(component.distortion()).toBe(100);
    expect(component.ca()).toBe(100);
    expect(component.vignetting()).toBe(100);
  });

  it('a live drag tracks the LOCAL value without writing the model', async () => {
    const { component, library } = await makeFixture();
    component.onDistortionChange(42);
    expect(component.distortion()).toBe(42);
    expect(library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('dragEnd commits the parked value exactly once, then reverts to model-tracking', async () => {
    const { component, library } = await makeFixture();
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

  it('the three sliders write distinct fields independently', async () => {
    const { component, library } = await makeFixture();
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

  it('reset writes the canonical default (100) immediately, no drag needed', async () => {
    const { component, library } = await makeFixture();
    component.onCaReset();
    expect(library.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { lensCorrectionCa: 100 });
  });
});

// #3182 — mirrors Apple's LensCorrectionsSection gate: the whole panel
// disables when the RAW has no OpcodeList3 at all; the CA slider ALSO
// disables on its own, independent of the whole-panel gate, when the RAW
// has corrections but its WarpRectilinear opcode has no per-plane CA data.
describe('LensCorrectionsPanelComponent — lens-correction capability gate (#3182)', async () => {
  it('disables the whole panel (toggle + all three sliders) when the RAW has no OpcodeList3', async () => {
    const { fixture, component, library } = await makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    fixture.detectChanges();

    expect(component.panelDisabled()).toBe(true);
    expect(component.caDisabled()).toBe(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-toggle"]')).toHaveProperty(
      'disabled',
      true,
    );
    expect(el.querySelector('[data-testid="lens-corrections-panel"]')?.className).toContain(
      'opacity-[0.45]',
    );
  });

  it('toggleEnabled is a no-op while the panel is disabled', async () => {
    const { component, library } = await makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    component.toggleEnabled();
    expect(library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('greys ONLY the CA slider when corrections exist but the CA scale is inert', async () => {
    const { fixture, component, library } = await makeFixture();
    library.seedLensCorrections(ASSET_ID, true, true);
    fixture.detectChanges();

    expect(component.panelDisabled()).toBe(false);
    expect(component.caInertOnly()).toBe(true);
    expect(component.caDisabled()).toBe(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-toggle"]')).toHaveProperty(
      'disabled',
      false,
    );
    expect(el.querySelector('[data-testid="lens-corrections-ca-wrap"]')?.className).toContain(
      'opacity-[0.45]',
    );
  });

  it('leaves everything interactive when corrections exist and CA is live', async () => {
    const { fixture, component, library } = await makeFixture();
    library.seedLensCorrections(ASSET_ID, true, false);
    fixture.detectChanges();

    expect(component.panelDisabled()).toBe(false);
    expect(component.caDisabled()).toBe(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-panel"]')?.className).not.toContain(
      'opacity-[0.45]',
    );
    expect(el.querySelector('[data-testid="lens-corrections-ca-wrap"]')?.className).not.toContain(
      'opacity-[0.45]',
    );
  });

  it('does not double-dim the CA slider when the whole panel is already disabled', async () => {
    // hasLensCorrections: false already implies lensCorrectionCaInert: true
    // (see raw-core's own contract) — the CA wrap must NOT ALSO apply its
    // own opacity class in that case, since the panel-level opacity already
    // covers it (multiplying two 0.45 opacities would over-dim).
    const { fixture, library } = await makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-ca-wrap"]')?.className).not.toContain(
      'opacity-[0.45]',
    );
  });
});
