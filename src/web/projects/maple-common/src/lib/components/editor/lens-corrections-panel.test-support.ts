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
import { vi } from 'vitest';
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

export const ASSET_ID = 'local-asset-1';
export const REFERENCE = `lcp1:${'a'.repeat(64)}`;

/** An imported-profile verdict covering distortion + vignetting but no CA model. */
export function importedVerdict(reference = REFERENCE): LensProfileResolution {
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

export type FakeLibraryStateService = ReturnType<typeof fakeLibraryState>;

function fakeLibraryState() {
  const focusedAssetId = signal<string | null>(ASSET_ID);
  const models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
  // #3182 — default every asset to "capable" (has corrections, CA live) so
  // every test written before this ticket keeps exercising the sliders
  // exactly as before; the dedicated describe block below overrides this
  // per-asset via `seedLensCorrections` to exercise the disabled states.
  const capabilities = new Map<string, ReturnType<typeof signal<LensCorrectionCapability>>>();

  function modelFor(id: string) {
    const existing = models.get(id);
    if (existing) return existing;
    const created = signal<AdjustmentModel>({ ...defaultAdjustmentModel() });
    models.set(id, created);
    return created;
  }

  function capsFor(id: string) {
    const existing = capabilities.get(id);
    if (existing) return existing;
    const created = signal<LensCorrectionCapability>({
      hasLensCorrections: true,
      lensCorrectionCaInert: false,
    });
    capabilities.set(id, created);
    return created;
  }

  return {
    focusedAssetId,
    adjustmentFor: vi.fn((id: string) => modelFor(id)),

    updateAdjustment: vi.fn((id: string, patch: Partial<AdjustmentModel>) => {
      modelFor(id).update((m) => ({ ...m, ...patch }));
    }),

    lensCorrectionsFor: vi.fn((id: string) => capsFor(id)()),

    seedLensCorrections: vi.fn(
      (
        id: string,
        hasLensCorrections: boolean,
        caInert: boolean,
        supportJson?: string,
        lensProfile?: LensProfileResolution,
      ) => {
        capsFor(id).set({
          hasLensCorrections,
          lensCorrectionCaInert: caInert,
          cameraSupport: cameraSupportFromJson(supportJson),
          ...(lensProfile ? { lensProfile } : {}),
        });
      },
    ),

    // The import block reads these too (#3479); the panel specs never pick a file.
    backend: 'hosted',
    focusedAsset: () => ({ id: ASSET_ID, filename: 'photo.dng' }),
    // The profile dropdown (#3569) fetches these on every render; a fixed
    // empty answer keeps it a harmless "Automatic — no match" passenger in
    // every spec below that isn't about the dropdown itself.
    bytesForAsset: vi.fn(async () => new Uint8Array()),
  };
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
export const fakePipeline = {
  importLensProfile: vi.fn(),
  lensProfileStatus: signal(null),
  compatibleLensProfiles: vi.fn(async (): Promise<CompatibleLensProfile[]> => []),
  lensProfileEvidence: vi.fn(async (): Promise<LensProfileEvidence> => NO_MATCH_EVIDENCE),
};

export function makeFixture() {
  const library = fakeLibraryState();
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
