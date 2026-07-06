// preview-shell.component.spec.ts — mirrors editor-shell.component.spec.ts's
// TestBed + stub pattern to guard PreviewShellComponent's route resolution
// (copied verbatim from EditorShellComponent.applyRouteAddress) and the
// header's back-navigation + filename derivation.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';

import { PreviewShellComponent } from './preview-shell.component';
import { LibraryStateService } from '../../state/library-state.service';

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
});
