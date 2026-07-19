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
    flushPendingPreviewWrites: vi.fn(),
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

  it('selects a bare-uuid landing import for /edit/<uuid> (Hosted "Open a photo")', () => {
    // The landing import navigates to `/edit/<uuid>` where the asset id IS the
    // uuid — no colon. `formatAddress({slug: uuid, relPath: ''})` yields
    // `<uuid>:` (trailing colon), which can never equal that id; without the
    // bare-slug fallback the editor resolved no asset, fell through to
    // `hydrateFromCache('')`, and bounced straight back to the landing (#1960).
    const uuid = '969741c4-1522-4935-b509-c37e447caf8e';
    const { selectAsset, navigate } = setup({
      slug: uuid,
      segments: [],
      backend: 'hosted',
      assets: [{ id: uuid }],
    });
    expect(selectAsset).toHaveBeenCalledWith(uuid);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('hydrates an fs: id as a single-asset open — no slug-addressed folder fetch', () => {
    const { selectAsset, openSelfHostedSubfolder, hydrateSelfHostedFsAsset } = setup({
      slug: 'fs:/srv/photos/x.jpg',
      segments: [],
      backend: 'self-hosted',
      // An fs: synth has no slug-addressable parent; its folderId resolves to
      // unknown:<path>, so listing it would 404.
      hydrate: () => ({
        id: 'fs:/srv/photos/x.jpg',
        absPath: '/srv/photos/x.jpg',
        folderId: 'unknown:/srv/photos',
      }),
    });
    expect(hydrateSelfHostedFsAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    expect(selectAsset).toHaveBeenCalledWith('fs:/srv/photos/x.jpg');
    // Must NOT open a folder listing for fs: — that hits /api/folder/unknown → 404.
    expect(openSelfHostedSubfolder).not.toHaveBeenCalled();
  });

  it('opens the parent folder for a slug:relPath deep-link not yet in memory', () => {
    const { selectAsset, openSelfHostedSubfolder } = setup({
      slug: 'library',
      segments: ['2026', 'a.jpg'],
      assets: [], // not loaded → falls through to the deep-link hydrate branch
      hydrate: () => ({
        id: 'library:2026/a.jpg',
        absPath: '/srv/lib/2026/a.jpg',
        folderId: 'library:2026',
      }),
    });
    expect(selectAsset).toHaveBeenCalledWith('library:2026/a.jpg');
    // slug:relPath HAS a real, addressable parent — open it so the filmstrip fills.
    expect(openSelfHostedSubfolder).toHaveBeenCalledWith(
      '2026',
      'library:2026',
      'library:2026/a.jpg',
    );
  });
});

// Phone CARD editor (#1807): the bottom horizontal dock arms a group AND
// opens the flyout control card; tapping the active group's icon again (or
// the card's own close button) closes it. Only one flyout — slider card or
// curve panel — is open at a time since both float in the same anchor slot.
describe('EditorShellComponent — phone dock wiring (#1807)', () => {
  it('tapping a group icon arms that group and opens the flyout card', () => {
    const { comp } = setup({ slug: null });
    expect(comp.phoneCardOpen()).toBe(false);

    comp.onPhoneDockGroupChange('color');

    expect(comp.activeGroup()).toBe('color');
    expect(comp.phoneCardOpen()).toBe(true);
  });

  it('tapping the already-active group icon again closes the flyout card', () => {
    const { comp } = setup({ slug: null });
    comp.onPhoneDockGroupChange('light');
    expect(comp.phoneCardOpen()).toBe(true);

    comp.onPhoneDockGroupChange('light');

    expect(comp.phoneCardOpen()).toBe(false);
    // Group stays armed — closing the flyout doesn't reset the selection.
    expect(comp.activeGroup()).toBe('light');
  });

  it('tapping a different group while the card is open re-arms without closing', () => {
    const { comp } = setup({ slug: null });
    comp.onPhoneDockGroupChange('light');
    comp.onPhoneDockGroupChange('effects');

    expect(comp.activeGroup()).toBe('effects');
    expect(comp.phoneCardOpen()).toBe(true);
  });

  it('closePhoneCard() closes the flyout without changing the armed group', () => {
    const { comp } = setup({ slug: null });
    comp.onPhoneDockGroupChange('detail');

    comp.closePhoneCard();

    expect(comp.phoneCardOpen()).toBe(false);
    expect(comp.activeGroup()).toBe('detail');
  });

  it('onPhoneCurvePanelToggle() opens the curve panel and closes the slider flyout', () => {
    const { comp } = setup({ slug: null });
    comp.onPhoneDockGroupChange('light');
    expect(comp.phoneCardOpen()).toBe(true);

    comp.onPhoneCurvePanelToggle();

    expect(comp.curveOpen()).toBe(true);
    expect(comp.phoneCardOpen()).toBe(false);
  });

  it('onPhoneDockGroupChange() closes an open curve panel before opening the slider flyout', () => {
    const { comp } = setup({ slug: null });
    comp.onPhoneCurvePanelToggle();
    expect(comp.curveOpen()).toBe(true);

    comp.onPhoneDockGroupChange('color');

    expect(comp.curveOpen()).toBe(false);
    expect(comp.phoneCardOpen()).toBe(true);
    expect(comp.activeGroup()).toBe('color');
  });
});
