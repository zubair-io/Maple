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
import { viewRouteCommands, editRouteCommands } from '../../addressing/route-address';
import { TabBarVisibilityService } from '../tab-bar-visibility.service';
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
  const ensureThumbnailUrl = vi.fn();
  const focusNext = vi.fn();
  const focusPrev = vi.fn();
  const setRating = vi.fn();
  const setFlag = vi.fn();

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
    ensureThumbnailUrl,
    flushPendingXmpWrites: vi.fn(),
    focusNext,
    focusPrev,
    setRating,
    setFlag,
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
    ensureThumbnailUrl,
    navigate,
    focusNext,
    focusPrev,
    setRating,
    setFlag,
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

  it('kicks off thumbnail extraction for the focused asset on open (direct /view nav)', () => {
    const asset = { id: 'library:2026/a.jpg', filename: '2026/a.jpg' };
    const { ensureThumbnailUrl } = setup({
      slug: null,
      segments: [],
      focusedAsset: asset,
      focusedAssetId: asset.id,
    });
    expect(ensureThumbnailUrl).toHaveBeenCalledWith(asset);
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

  it('resolves a raw (non-address) id passed as the slug, like /library/editor/:id did', () => {
    // Search/People/Pano/deep-links pass a raw Mongo _id (no ':') via
    // viewRouteCommands(), which emits it as a single `/view/<id>` segment —
    // it lands in the `:slug` param with no further `**` segments.
    const { comp, selectAsset } = setup({
      slug: 'raw-mongo-id-123',
      segments: [],
      assets: [{ id: 'raw-mongo-id-123', filename: 'foo/bar.jpg' }],
    });
    expect(comp).toBeTruthy();
    expect(selectAsset).toHaveBeenCalledWith('raw-mongo-id-123');
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

  it('Edit navigates to the canvas-first editor route (S5 retired, #1807)', () => {
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

  // ── Prev/next navigation + keyboard shortcuts (#Web Preview Surface Task 5) ─

  it('goNext() calls focusNext then navigates to the newly focused asset', () => {
    const { comp, focusNext, navigate } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/b.jpg',
    });
    comp.goNext();
    expect(focusNext).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(viewRouteCommands('library:2026/b.jpg'));
  });

  it('goPrev() calls focusPrev then navigates to the newly focused asset', () => {
    const { comp, focusPrev, navigate } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/z.jpg',
    });
    comp.goPrev();
    expect(focusPrev).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(viewRouteCommands('library:2026/z.jpg'));
  });

  it('goNext()/goPrev() do not navigate when there is no focused asset', () => {
    const { comp, focusNext, focusPrev, navigate } = setup({
      slug: null,
      segments: [],
      focusedAssetId: null,
    });
    navigate.mockClear();
    comp.goNext();
    comp.goPrev();
    expect(focusNext).toHaveBeenCalled();
    expect(focusPrev).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ArrowRight/ArrowLeft keydown navigates next/prev', () => {
    const { comp, focusNext, focusPrev } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    const right = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    Object.defineProperty(right, 'target', { value: document.body });
    comp.onKeydown(right);
    expect(focusNext).toHaveBeenCalledTimes(1);

    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    Object.defineProperty(left, 'target', { value: document.body });
    comp.onKeydown(left);
    expect(focusPrev).toHaveBeenCalledTimes(1);
  });

  it('rating keydown (1-5, 0) calls setRating on the focused asset', () => {
    const { comp, setRating } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    const three = new KeyboardEvent('keydown', { key: '3' });
    Object.defineProperty(three, 'target', { value: document.body });
    comp.onKeydown(three);
    expect(setRating).toHaveBeenCalledWith('library:2026/a.jpg', 3);

    const zero = new KeyboardEvent('keydown', { key: '0' });
    Object.defineProperty(zero, 'target', { value: document.body });
    comp.onKeydown(zero);
    expect(setRating).toHaveBeenCalledWith('library:2026/a.jpg', 0);
  });

  it('flag keydown (p/x/u) calls setFlag on the focused asset', () => {
    const { comp, setFlag } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    const p = new KeyboardEvent('keydown', { key: 'p' });
    Object.defineProperty(p, 'target', { value: document.body });
    comp.onKeydown(p);
    expect(setFlag).toHaveBeenCalledWith('library:2026/a.jpg', 'pick');

    const x = new KeyboardEvent('keydown', { key: 'x' });
    Object.defineProperty(x, 'target', { value: document.body });
    comp.onKeydown(x);
    expect(setFlag).toHaveBeenCalledWith('library:2026/a.jpg', 'reject');

    const u = new KeyboardEvent('keydown', { key: 'u' });
    Object.defineProperty(u, 'target', { value: document.body });
    comp.onKeydown(u);
    expect(setFlag).toHaveBeenCalledWith('library:2026/a.jpg', 'unflagged');
  });

  it('skips keydown handling when focus is in an input element', () => {
    const { comp, focusNext, setRating } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    const input = document.createElement('input');
    const evt = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    Object.defineProperty(evt, 'target', { value: input });
    comp.onKeydown(evt);
    expect(focusNext).not.toHaveBeenCalled();

    const ratingEvt = new KeyboardEvent('keydown', { key: '3' });
    Object.defineProperty(ratingEvt, 'target', { value: input });
    comp.onKeydown(ratingEvt);
    expect(setRating).not.toHaveBeenCalled();
  });

  it('ignores unmapped keys without navigating or mutating state', () => {
    const { comp, focusNext, focusPrev, setRating, setFlag } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg', filename: '2026/a.jpg' }],
      focusedAssetId: 'library:2026/a.jpg',
    });
    const evt = new KeyboardEvent('keydown', { key: 'q' });
    Object.defineProperty(evt, 'target', { value: document.body });
    comp.onKeydown(evt);
    expect(focusNext).not.toHaveBeenCalled();
    expect(focusPrev).not.toHaveBeenCalled();
    expect(setRating).not.toHaveBeenCalled();
    expect(setFlag).not.toHaveBeenCalled();
  });

  // ── Swipe gesture on .preview-image-wrap ─────────────────────────────────

  it('a leftward swipe past the threshold calls goNext', () => {
    const { fixture, navigate } = setupFixture();
    const comp = fixture.componentInstance;
    const goNextSpy = vi.spyOn(comp, 'goNext');
    comp.onImagePointerDown({ clientX: 300, clientY: 100 } as PointerEvent);
    comp.onImagePointerUp({ clientX: 240, clientY: 105 } as PointerEvent);
    expect(goNextSpy).toHaveBeenCalled();
    void navigate; // navigate assertions covered by goNext/goPrev unit tests above
  });

  it('a rightward swipe past the threshold calls goPrev', () => {
    const { fixture } = setupFixture();
    const comp = fixture.componentInstance;
    const goPrevSpy = vi.spyOn(comp, 'goPrev');
    comp.onImagePointerDown({ clientX: 100, clientY: 100 } as PointerEvent);
    comp.onImagePointerUp({ clientX: 170, clientY: 95 } as PointerEvent);
    expect(goPrevSpy).toHaveBeenCalled();
  });

  it('a short drag under the threshold does not navigate', () => {
    const { fixture } = setupFixture();
    const comp = fixture.componentInstance;
    const goNextSpy = vi.spyOn(comp, 'goNext');
    const goPrevSpy = vi.spyOn(comp, 'goPrev');
    comp.onImagePointerDown({ clientX: 100, clientY: 100 } as PointerEvent);
    comp.onImagePointerUp({ clientX: 115, clientY: 100 } as PointerEvent);
    expect(goNextSpy).not.toHaveBeenCalled();
    expect(goPrevSpy).not.toHaveBeenCalled();
  });

  it('a mostly-vertical drag past the horizontal threshold does not navigate', () => {
    const { fixture } = setupFixture();
    const comp = fixture.componentInstance;
    const goNextSpy = vi.spyOn(comp, 'goNext');
    const goPrevSpy = vi.spyOn(comp, 'goPrev');
    comp.onImagePointerDown({ clientX: 100, clientY: 100 } as PointerEvent);
    comp.onImagePointerUp({ clientX: 150, clientY: 200 } as PointerEvent);
    expect(goNextSpy).not.toHaveBeenCalled();
    expect(goPrevSpy).not.toHaveBeenCalled();
  });

  // ── Phone tab-bar suppression (#Web Preview Surface Task 6a) ────────────

  it('hides the phone tab bar on init and restores it on destroy', () => {
    const { fixture } = setupFixture();
    const tabBar = TestBed.inject(TabBarVisibilityService);
    expect(tabBar.hidden()).toBe(true);
    fixture.destroy();
    expect(tabBar.hidden()).toBe(false);
  });
});
