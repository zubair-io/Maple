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
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { LensProfileResolution } from '../../lens/lens-profile.types';
import type {
  CompatibleLensProfile,
  LensProfileEvidence,
} from '../../lens/lens-profile-choice.types';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { LensCorrectionCapability } from '../../state/library-store-lens-corrections';
import { cameraSupportFromJson } from '../../state/camera-support';

const ASSET_ID = 'local-asset-1';
const REFERENCE = `lcp1:${'a'.repeat(64)}`;

/** An imported-profile verdict covering distortion + vignetting but no CA model. */
function importedVerdict(reference = REFERENCE): LensProfileResolution {
  return {
    source: 'lcp',
    confidence: 'in-range',
    reference,
    enabled: true,
    approximations: [],
    unsupported: [],
    hasDistortion: true,
    hasCa: false,
    hasVignetting: true,
    distortion: [],
    ca: [],
    vignetting: [],
  };
}

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
    (
      id: string,
      hasLensCorrections: boolean,
      caInert: boolean,
      supportJson?: string,
      lensProfile?: LensProfileResolution,
    ) => {
      this.capsFor(id).set({
        hasLensCorrections,
        lensCorrectionCaInert: caInert,
        cameraSupport: cameraSupportFromJson(supportJson),
        ...(lensProfile ? { lensProfile } : {}),
      });
    },
  );

  // The import block reads these too (#3479); the panel specs never pick a file.
  backend = 'hosted';
  focusedAsset = () => ({ id: ASSET_ID, filename: 'photo.dng' });
  // The profile dropdown (#3569) fetches these on every render; a fixed
  // empty answer keeps it a harmless "Automatic — no match" passenger in
  // every spec below that isn't about the dropdown itself.
  bytesForAsset = vi.fn(async () => new Uint8Array());
}

// The import block's only pipeline reads: the worker import (never invoked
// here) and the availability broadcast. `compatibleLensProfiles`/
// `lensProfileEvidence` back the profile dropdown (#3569) — see
// `lens-profile-select.component.spec.ts` for its own dedicated coverage.
const NO_MATCH_EVIDENCE: LensProfileEvidence = {
  source: 'none',
  confidence: 'embedded',
  hasDistortion: false,
  hasCa: false,
  hasVignetting: false,
  approximations: [],
  unsupported: [],
};
const fakePipeline = {
  importLensProfile: vi.fn(),
  lensProfileStatus: signal(null),
  compatibleLensProfiles: vi.fn(async (): Promise<CompatibleLensProfile[]> => []),
  lensProfileEvidence: vi.fn(async (): Promise<LensProfileEvidence> => NO_MATCH_EVIDENCE),
};

function makeFixture() {
  const library = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [LensCorrectionsPanelComponent],
    providers: [
      { provide: LibraryStateService, useValue: library },
      { provide: RawPipelineService, useValue: fakePipeline },
    ],
  });
  const fixture = TestBed.createComponent(LensCorrectionsPanelComponent);
  fixture.detectChanges();
  return { fixture, library, component: fixture.componentInstance };
}

describe('LensCorrectionsPanelComponent', () => {
  it('explains missing lens correction independently of the camera calibration', () => {
    const { fixture, library } = makeFixture();
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

// #3182 — mirrors Apple's LensCorrectionsSection gate: the whole panel
// disables when the RAW has no OpcodeList3 at all; the CA slider ALSO
// disables on its own, independent of the whole-panel gate, when the RAW
// has corrections but its WarpRectilinear opcode has no per-plane CA data.
describe('LensCorrectionsPanelComponent — lens-correction capability gate (#3182)', () => {
  it('disables the whole panel (toggle + all three sliders) when the RAW has no OpcodeList3', () => {
    const { fixture, component, library } = makeFixture();
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

  it('toggleEnabled is a no-op while the panel is disabled', () => {
    const { component, library } = makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    component.toggleEnabled();
    expect(library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('greys ONLY the CA slider when corrections exist but the CA scale is inert', () => {
    const { fixture, component, library } = makeFixture();
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

  it('leaves everything interactive when corrections exist and CA is live', () => {
    const { fixture, component, library } = makeFixture();
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

  it('does not double-dim the CA slider when the whole panel is already disabled', () => {
    // hasLensCorrections: false already implies lensCorrectionCaInert: true
    // (see raw-core's own contract) — the CA wrap must NOT ALSO apply its
    // own opacity class in that case, since the panel-level opacity already
    // covers it (multiplying two 0.45 opacities would over-dim).
    const { fixture, library } = makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-ca-wrap"]')?.className).not.toContain(
      'opacity-[0.45]',
    );
  });
});

// #3479 — an imported LCP profile is the other way the panel comes alive:
// once the sidecar names it AND a render has reported the resolver's verdict
// for that exact reference, the panel enables without any OpcodeList3 and
// each strength slider follows the families the calibration actually covers.
describe('LensCorrectionsPanelComponent — imported lens profile (#3479)', () => {
  function seedImported(library: FakeLibraryStateService, reference = REFERENCE) {
    library.updateAdjustment(ASSET_ID, { lensProfile: REFERENCE });
    library.seedLensCorrections(ASSET_ID, false, true, undefined, importedVerdict(reference));
  }

  it('mounts the import block above the controls', () => {
    const { fixture } = makeFixture();
    const el = fixture.nativeElement as HTMLElement;
    const importBlock = el.querySelector('[data-testid="lens-profile-import"]');
    const controls = el.querySelector('[data-testid="lens-corrections-panel"]');
    expect(importBlock).not.toBeNull();
    expect(importBlock!.compareDocumentPosition(controls!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('enables the panel without OpcodeList3 and disables only the uncalibrated family', () => {
    const { fixture, component, library } = makeFixture();
    seedImported(library);
    fixture.detectChanges();

    expect(component.imported()?.reference).toBe(REFERENCE);
    expect(component.panelDisabled()).toBe(false);
    expect(component.distortionDisabled()).toBe(false);
    expect(component.vignettingDisabled()).toBe(false);
    expect(component.caInertOnly()).toBe(true);
    expect(component.caDisabled()).toBe(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-toggle"]')).toHaveProperty(
      'disabled',
      false,
    );
    expect(el.querySelector('[data-testid="lens-corrections-panel"]')?.className).not.toContain(
      'opacity-[0.45]',
    );
    expect(el.querySelector('[data-testid="lens-corrections-ca-wrap"]')?.className).toContain(
      'opacity-[0.45]',
    );
  });

  it('hides the bundled-calibration note while an imported profile applies', () => {
    const { fixture, library } = makeFixture();
    library.seedLensCorrections(
      ASSET_ID,
      false,
      true,
      JSON.stringify({
        cameraKey: 'Example',
        resolution: 'bundle_confident',
        lens: 'no_correction_data',
      }),
      importedVerdict(),
    );
    library.updateAdjustment(ASSET_ID, { lensProfile: REFERENCE });
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="lens-support"]'),
    ).toBeNull();
  });

  it('ignores a verdict for a profile the sidecar no longer names', () => {
    const { fixture, component, library } = makeFixture();
    seedImported(library, `lcp1:${'b'.repeat(64)}`);
    fixture.detectChanges();
    expect(component.imported()).toBeUndefined();
    expect(component.panelDisabled()).toBe(true);
  });

  it('leaves the opcode gate in charge when the RAW carries embedded corrections', () => {
    const { fixture, component, library } = makeFixture();
    library.updateAdjustment(ASSET_ID, { lensProfile: REFERENCE });
    library.seedLensCorrections(ASSET_ID, true, false, undefined, {
      source: 'embedded',
      confidence: 'embedded',
      reference: REFERENCE,
      approximations: [],
      unsupported: [],
    });
    fixture.detectChanges();
    expect(component.imported()).toBeUndefined();
    expect(component.panelDisabled()).toBe(false);
    expect(component.caDisabled()).toBe(false);
  });
});

// #3569 — a bundled Lensfun match is a THIRD way the panel comes alive,
// read from the profile dropdown's own resolved evidence (`viewChild`) since
// that state lives in `LensProfileSelectComponent`, not here. Verified live
// against a real fixture (Canon EOS 5D Mark III + EF70-200mm f/2.8L IS II
// USM, no embedded OpcodeList3) before this gate existed: the toggle and
// sliders were disabled even though the develop path was already applying
// the automatic match.
describe('LensCorrectionsPanelComponent — bundled Lensfun match (#3569)', () => {
  const LENSFUN_MATCH: LensProfileEvidence = {
    source: 'lensfun',
    confidence: 'in-range',
    lens: 'Canon EF 70-200mm f/2.8L IS II USM',
    dbVersion: '12f5976',
    hasDistortion: true,
    hasCa: false,
    hasVignetting: true,
    approximations: [],
    unsupported: [],
  };

  it('enables the panel for an automatic bundled match with no OpcodeList3', async () => {
    fakePipeline.compatibleLensProfiles.mockResolvedValueOnce([
      {
        slug: 'canon/ef-70-200mm-f2.8l-is-ii-usm@canon-ef',
        maker: 'Canon',
        model: 'EF 70-200mm f/2.8L IS II USM',
      },
    ]);
    fakePipeline.lensProfileEvidence.mockResolvedValueOnce(LENSFUN_MATCH);
    const { fixture, component, library } = makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.panelDisabled()).toBe(false));
    fixture.detectChanges();

    expect(component.bundledMatch()?.lens).toBe('Canon EF 70-200mm f/2.8L IS II USM');
    expect(component.distortionDisabled()).toBe(false);
    expect(component.vignettingDisabled()).toBe(false);
    // The matched calibration carries no CA model — same "family alone
    // stays inert" shape as the imported-LCP case above.
    expect(component.caInertOnly()).toBe(true);
    expect(component.caDisabled()).toBe(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lens-corrections-toggle"]')).toHaveProperty(
      'disabled',
      false,
    );
    expect(el.querySelector('[data-testid="lens-support"]')).toBeNull();
  });

  it('enables just the toggle when nothing matched automatically but a lens is pickable', async () => {
    fakePipeline.compatibleLensProfiles.mockResolvedValueOnce([
      { slug: 'canon/ef-50mm-f1.2l-usm@canon-ef', maker: 'Canon', model: 'EF 50mm f/1.2L USM' },
    ]);
    // `lensProfileEvidence` keeps the module default (no match) — Automatic
    // resolves to nothing, but the dropdown still has something to pick.
    const { fixture, component, library } = makeFixture();
    library.seedLensCorrections(ASSET_ID, false, true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.panelDisabled()).toBe(false));
    fixture.detectChanges();

    expect(component.bundledMatch()).toBeUndefined();
    // No resolved coverage yet — each strength stays disabled until a pick resolves.
    expect(component.distortionDisabled()).toBe(true);
    expect(component.vignettingDisabled()).toBe(true);
  });
});
