// editor-shell.component.spec.ts — guards applyRouteAddress route resolution.
//
// These are the paths the click-to-open bug (#1367/#1368) lived in: the editor
// must resolve the asset from the /edit/:slug/** route. We instantiate the
// component class with mocked injectables and let the constructor's route.url
// subscription run applyRouteAddress — no heavy template render needed.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';

import { EditorShellComponent } from './editor-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';

interface Synth {
  id: string;
  absPath?: string;
  folderId?: string;
}

function setup(opts: {
  slug: string | null;
  segments?: string[];
  assets?: { id: string }[];
  backend?: string;
  hydrate?: (id: string) => Synth | null;
}) {
  const selectAsset = vi.fn();
  const openSelfHostedSubfolder = vi.fn();
  const navigate = vi.fn();
  const hydrateSelfHostedFsAsset = vi.fn(opts.hydrate ?? (() => null));

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
    selectAsset,
    openSelfHostedSubfolder,
    hydrateSelfHostedFsAsset,
    flushPendingXmpWrites: vi.fn(),
    sidebarVisible: () => true,
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate } },
      { provide: LibraryStateService, useValue: state },
      { provide: ImageCanvasService, useValue: {} },
    ],
  });
  // Constructing inside the injection context wires the inject() fields; the
  // route.url subscription fires applyRouteAddress synchronously (of() emits).
  const comp = TestBed.runInInjectionContext(() => new EditorShellComponent());
  return { comp, selectAsset, openSelfHostedSubfolder, hydrateSelfHostedFsAsset, navigate };
}

describe('EditorShellComponent.applyRouteAddress', () => {
  it('selects the asset for an M2 /edit/:slug/** route', () => {
    const { selectAsset } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [{ id: 'library:2026/a.jpg' }],
    });
    // slug='library' + segments=['2026','a.jpg'] → address 'library:2026/a.jpg',
    // which matches the loaded asset → selected. (The bug routed the whole id as
    // :slug, so this never matched and the editor bounced to Browse.)
    expect(selectAsset).toHaveBeenCalledWith('library:2026/a.jpg');
  });

  it('hydrates a legacy fs: id routed as a single :slug segment (search results)', () => {
    const { selectAsset, openSelfHostedSubfolder, hydrateSelfHostedFsAsset } = setup({
      slug: 'fs:/srv/photos/x.jpg',
      segments: [],
      backend: 'self-hosted',
      hydrate: () => ({ id: 'fs:/srv/photos/x.jpg', absPath: '/srv/photos/x.jpg', folderId: 'f1' }),
    });
    expect(hydrateSelfHostedFsAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    expect(selectAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    expect(openSelfHostedSubfolder).toHaveBeenCalledWith(
      '/srv/photos',
      'f1',
      'fs:/srv/photos/x.jpg',
    );
  });

  it('does not treat fs: as an address — never builds a slug:relPath from it', () => {
    // If the fs: branch were missing, applyRouteAddress would fall through to
    // routeSegmentsToAddress('fs:/srv/x.jpg', []) and find no asset.
    const { selectAsset } = setup({
      slug: 'fs:/srv/x.jpg',
      segments: [],
      hydrate: () => ({ id: 'fs:/srv/x.jpg', absPath: '/srv/x.jpg', folderId: 'f2' }),
    });
    expect(selectAsset).toHaveBeenCalledWith('fs:/srv/x.jpg');
  });

  it('opens the FS root as the parent for an asset stored at the root', () => {
    // absPath '/photo.jpg' → lastSlash === 0; a `> 0` guard would skip opening
    // the parent entirely, leaving the filmstrip empty.
    const { openSelfHostedSubfolder } = setup({
      slug: 'fs:/photo.jpg',
      segments: [],
      hydrate: () => ({ id: 'fs:/photo.jpg', absPath: '/photo.jpg', folderId: 'f3' }),
    });
    expect(openSelfHostedSubfolder).toHaveBeenCalledWith('/', 'f3', 'fs:/photo.jpg');
  });
});
