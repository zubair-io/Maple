// Shared full-template fixture for the PreviewShell specs. Extracted so the
// route-resolution spec and the responsive/info-pane specs share one TestBed
// setup rather than duplicating it — and so neither file grows past the
// changed-file LOC headroom gate.

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { signal, type WritableSignal } from '@angular/core';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { PreviewShellComponent } from './preview-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { BunApiBackendService } from '../../api/bun-api-backend.service';
import { LayoutService, type MapleLayout } from '../../layout-service';
import type { Asset } from '../../models/asset';

export const STUB_ASSET: Asset = {
  id: 'library:2026/a.jpg',
  filename: '2026/a.jpg',
  folderId: 'folder-1',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

/** Full-template fixture (via `TestBed.createComponent`) for the bottom
 * action bar — needs `LIBRARY_BACKEND` + `BunApiBackendService` stubs
 * because `<app-info-panel>` (imported for the Info sheet/pane) pulls in
 * `<app-info-enrichment>` and `<app-info-histogram>`, which inject those
 * services. Mirrors info-panel.component.spec.ts's fake-service pattern.
 *
 * The returned `layout` signal is the one backing `LayoutService`, so a test
 * can drive a viewport resize by setting it and re-running change detection. */
export function setupFixture(
  opts: { navigate?: ReturnType<typeof vi.fn>; layout?: MapleLayout } = {},
) {
  const navigate = opts.navigate ?? vi.fn();
  const state = {
    backend: 'self-hosted',
    assets: () => [{ id: STUB_ASSET.id, filename: STUB_ASSET.filename }],
    assetsInSelectedFolder: () => [],
    focusedAsset: signal<Asset | null>(STUB_ASSET),
    focusedAssetId: signal<string | undefined>(STUB_ASSET.id),
    selectAsset: vi.fn(),
    openSelfHostedSubfolder: vi.fn(),
    hydrateSelfHostedFsAsset: vi.fn(() => null),
    subscribeThumbUrl: vi.fn(() => () => {}),
    subscribePreviewUrl: vi.fn(() => () => {}),
    ensureThumbnailUrl: vi.fn(),
    flushPendingXmpWrites: vi.fn(),
    setFlag: vi.fn(),
    setRating: vi.fn(),
    focusNext: vi.fn(),
    focusPrev: vi.fn(),
    apiIdFor: vi.fn().mockReturnValue(undefined),
  };
  const route = {
    url: of([]),
    snapshot: { paramMap: convertToParamMap({}), url: [] },
  };
  const fakeBunApi = {
    getWorkerStatus: vi.fn().mockReturnValue(of({ stages: [] })),
    getAssetDetails: vi.fn().mockReturnValue(of()),
    // Grid assets carry no Mongo id, so the enrichment pane now resolves their
    // detail by `slug:relPath` address (#2236). `of()` completes without
    // emitting, leaving the pane empty — what this spec already asserts.
    getAssetDetailsByAddress: vi.fn().mockReturnValue(of()),
    setAssetPlaceOverride: vi.fn(),
    setAssetDescriptionOverride: vi.fn(),
    requeueEnrichmentStage: vi.fn(),
    getHistogram: vi
      .fn()
      .mockReturnValue(
        of({ r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) }),
      ),
  };
  // Defaults to 'tablet' (tablet+) so the pre-existing (layout-agnostic)
  // tests keep exercising the same DOM shape they always have.
  const layout: WritableSignal<MapleLayout> = signal(opts.layout ?? 'tablet');

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PreviewShellComponent],
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate } },
      { provide: LibraryStateService, useValue: state },
      { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      { provide: BunApiBackendService, useValue: fakeBunApi },
      { provide: LayoutService, useValue: { layout } },
    ],
  });
  const fixture = TestBed.createComponent(PreviewShellComponent);
  fixture.detectChanges();
  return { fixture, navigate, state, layout };
}
