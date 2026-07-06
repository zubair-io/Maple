// preview-shell.component.spec.ts — mirrors editor-shell.component.spec.ts's
// TestBed + stub pattern to guard PreviewShellComponent's route resolution
// (copied verbatim from EditorShellComponent.applyRouteAddress) and the
// header's back-navigation + filename derivation.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { PreviewShellComponent } from './preview-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { BunApiBackendService } from '../../api/bun-api-backend.service';
import { editRouteCommands } from '../../addressing/route-address';
import type { Asset } from '../../models/asset';

interface Synth {
  id: string;
  absPath?: string;
  folderId?: string;
}

function setup(opts: {
  slug: string | null;
  segments?: string[];
  assets?: { id: string; filename: string }[];
  focusedAsset?: { id: string; filename: string } | null;
  focusedAssetId?: string | null;
  backend?: string;
  hydrate?: (id: string) => Synth | null;
}) {
  const selectAsset = vi.fn();
  const openSelfHostedSubfolder = vi.fn();
  const navigate = vi.fn();
  const hydrateSelfHostedFsAsset = vi.fn(opts.hydrate ?? (() => null));
  const subscribeThumbUrl = vi.fn(() => () => {});
  const subscribePreviewUrl = vi.fn(() => () => {});

  const urlSegments = (opts.segments ?? []).map((p) => ({ path: p }));
  const route = {
    url: of(urlSegments),
    snapshot: {
      paramMap: convertToParamMap(opts.slug ? { slug: opts.slug } : {}),
      url: urlSegments,
    },
  };
  const state = {
    backend: opts.backend ?? 'self-hosted',
    assets: () => opts.assets ?? [],
    assetsInSelectedFolder: () => [],
    focusedAsset: () => opts.focusedAsset ?? null,
    focusedAssetId: () => opts.focusedAssetId ?? null,
    selectAsset,
    openSelfHostedSubfolder,
    hydrateSelfHostedFsAsset,
    subscribeThumbUrl,
    subscribePreviewUrl,
    flushPendingXmpWrites: vi.fn(),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate } },
      { provide: LibraryStateService, useValue: state },
    ],
  });
  // Constructing inside the injection context wires the inject() fields; the
  // route.url subscription fires applyRouteAddress synchronously (of() emits).
  const comp = TestBed.runInInjectionContext(() => new PreviewShellComponent());
  // The thumb/preview url subscription effect() only runs on the next
  // reactive flush (real change detection ticks it automatically; the test
  // harness must flush explicitly since nothing here renders a template).
  TestBed.flushEffects();
  return {
    comp,
    selectAsset,
    openSelfHostedSubfolder,
    hydrateSelfHostedFsAsset,
    subscribeThumbUrl,
    subscribePreviewUrl,
    navigate,
  };
}

const STUB_ASSET: Asset = {
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
 * services. Mirrors info-panel.component.spec.ts's fake-service pattern. */
function setupFixture(opts: { navigate?: ReturnType<typeof vi.fn> } = {}) {
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
    flushPendingXmpWrites: vi.fn(),
    setFlag: vi.fn(),
    setRating: vi.fn(),
    apiIdFor: vi.fn().mockReturnValue(undefined),
  };
  const route = {
    url: of([]),
    snapshot: { paramMap: convertToParamMap({}), url: [] },
  };
  const fakeBunApi = {
    getWorkerStatus: vi.fn().mockReturnValue(of({ stages: [] })),
    getAssetDetails: vi.fn(),
    setAssetPlaceOverride: vi.fn(),
    setAssetDescriptionOverride: vi.fn(),
    requeueEnrichmentStage: vi.fn(),
    getHistogram: vi
      .fn()
      .mockReturnValue(
        of({ r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) }),
      ),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PreviewShellComponent],
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate } },
      { provide: LibraryStateService, useValue: state },
      { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      { provide: BunApiBackendService, useValue: fakeBunApi },
    ],
  });
  const fixture = TestBed.createComponent(PreviewShellComponent);
  fixture.detectChanges();
  return { fixture, navigate, state };
}

describe('PreviewShellComponent', () => {
  it('mounts and resolves the route asset into focusedAsset via selectAsset', () => {
    const { comp, selectAsset } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
    });
    expect(comp).toBeTruthy();
    // slug='library' + segments=['2026','a.jpg'] → address 'library:2026/a.jpg',
    // which matches the loaded asset → selected.
    expect(selectAsset).toHaveBeenCalledWith('library:2026/a.jpg');
  });

  it('assetName() returns the basename of the focused asset filename', () => {
    const { comp } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAsset: { id: 'library:2026/a.jpg', filename: '2026/a.jpg' },
    });
    expect(comp.assetName()).toBe('a.jpg');
  });

  it('goBack() navigates to /browse', () => {
    const { comp, navigate } = setup({ slug: null, segments: [] });
    comp.goBack();
    expect(navigate).toHaveBeenCalledWith(['/browse']);
  });

  it('subscribes to thumb + preview urls for the focused asset id', () => {
    const { subscribeThumbUrl, subscribePreviewUrl } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    expect(subscribeThumbUrl).toHaveBeenCalledWith('library:2026/a.jpg', expect.any(Function));
    expect(subscribePreviewUrl).toHaveBeenCalledWith('library:2026/a.jpg', expect.any(Function));
  });

  it('hydrates an fs: id as a single-asset open — no slug-addressed folder fetch', () => {
    const { selectAsset, openSelfHostedSubfolder, hydrateSelfHostedFsAsset } = setup({
      slug: 'fs:/srv/photos/x.jpg',
      segments: [],
      backend: 'self-hosted',
      hydrate: () => ({
        id: 'fs:/srv/photos/x.jpg',
        absPath: '/srv/photos/x.jpg',
        folderId: 'unknown:/srv/photos',
      }),
    });
    expect(hydrateSelfHostedFsAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    expect(selectAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    expect(openSelfHostedSubfolder).not.toHaveBeenCalled();
  });

  // ── Flag/Edit/Info bottom bar (#Web Preview Surface Task 4) ─────────────

  it('renders the bottom action bar with three labelled controls', () => {
    const { fixture } = setupFixture();
    const el = fixture.nativeElement as HTMLElement;
    const bar = el.querySelector('.action-bar');
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('[aria-label="Flag"]')).not.toBeNull();
    expect(bar!.querySelector('[aria-label="Edit"]')).not.toBeNull();
    expect(bar!.querySelector('[aria-label="Info"]')).not.toBeNull();
  });

  it('Edit navigates via editRouteCommands for the focused asset id', () => {
    const { fixture, navigate } = setupFixture();
    const el = fixture.nativeElement as HTMLElement;
    const editBtn = el.querySelector('[aria-label="Edit"]') as HTMLButtonElement;
    editBtn.click();
    expect(navigate).toHaveBeenCalledWith(editRouteCommands(STUB_ASSET.id));
  });

  it('Flag click toggles flagOpen and shows the rating/flags popover', () => {
    const { fixture } = setupFixture();
    const comp = fixture.componentInstance;
    expect(comp.flagOpen()).toBe(false);
    const el = fixture.nativeElement as HTMLElement;
    const flagBtn = el.querySelector('[aria-label="Flag"]') as HTMLButtonElement;
    flagBtn.click();
    fixture.detectChanges();
    expect(comp.flagOpen()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.flag-popover')).not.toBeNull();
  });

  it('Info click sets infoOpen to true', () => {
    const { fixture } = setupFixture();
    const comp = fixture.componentInstance;
    expect(comp.infoOpen()).toBe(false);
    const el = fixture.nativeElement as HTMLElement;
    const infoBtn = el.querySelector('[aria-label="Info"]') as HTMLButtonElement;
    infoBtn.click();
    fixture.detectChanges();
    expect(comp.infoOpen()).toBe(true);
  });
});
