// editor-shell.component.spec.ts — guards applyRouteAddress route resolution.
//
// These are the paths the click-to-open bug (#1367/#1368) lived in: the editor
// must resolve the asset from the /edit/:slug/** route. We instantiate the
// component class with mocked injectables and let the constructor's route.url
// subscription run applyRouteAddress — no heavy template render needed.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { EditorShellComponent } from './editor-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { CropSessionService } from '../../components/crop-overlay/crop-session.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

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

// Phone CARD editor (#1807 Task 5): the slider card is now always visible
// above the bottom horizontal dock — no closeable flyout (see the full-render
// test below). `onPhoneDockGroupChange` still exists as its own handler
// because tapping a dock group icon must also close an open curve panel: the
// always-visible card and the curve panel float in the same anchor above the
// dock, so they'd stack on top of each other otherwise. Curve, Crop, and
// Presets no longer need a phone-specific wrapper — closing the (now-removed)
// flyout was their only phone-specific behaviour — so the template wires
// them straight to `onCurvePanelToggle`/`onToolChange`/`onPresetsPanelToggle`,
// same as tablet/desktop.
describe('EditorShellComponent — phone dock wiring (#1807 Task 5)', () => {
  it('tapping a group icon arms that group', () => {
    const { comp } = setup({ slug: null });

    comp.onPhoneDockGroupChange('color');

    expect(comp.activeGroup()).toBe('color');
  });

  it('tapping a group icon closes an open curve panel — both float in the same anchor', () => {
    const { comp } = setup({ slug: null });
    comp.onCurvePanelToggle();
    expect(comp.curveOpen()).toBe(true);

    comp.onPhoneDockGroupChange('color');

    expect(comp.curveOpen()).toBe(false);
    expect(comp.activeGroup()).toBe('color');
  });
});

// ── Phone two-card layout (#1807 Task 5) ────────────────────────────────
// Full template render (not just class instantiation like `setup()` above)
// — the always-visible card only shows up in the assembled DOM. Harness
// mirrors `editor-shell-subtool-row.spec.ts` / `editor-shell-hsl.spec.ts`'s
// full-render setup.

function stubGlobalsForRender(): void {
  const observerStub = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;
  (globalThis as unknown as { ImageData: unknown }).ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(() =>
    Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
  );
}

function setWindowWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

const RENDER_ASSET_ID = 'library:2026/render.dng' as AssetId;

function renderShell(opts: {
  layout: 'phone' | 'tablet' | 'desktop';
}): ComponentFixture<EditorShellComponent> {
  stubGlobalsForRender();
  const width = opts.layout === 'phone' ? 375 : opts.layout === 'tablet' ? 900 : 1280;
  setWindowWidth(width);

  const models = new Map<AssetId, WritableSignal<AdjustmentModel>>();
  const modelFor = (id: AssetId): WritableSignal<AdjustmentModel> => {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  };
  const focused = signal<Asset | null>({
    id: RENDER_ASSET_ID,
    filename: 'render.dng',
    width: 6240,
    height: 4160,
  } as Asset);

  const route = { url: of([]), snapshot: { paramMap: convertToParamMap({}), url: [] } };

  const stateStub = {
    backend: 'self-hosted',
    focusedAsset: focused,
    focusedAssetId: () => focused()?.id ?? null,
    assets: () => [focused()!].filter(Boolean),
    assetsInSelectedFolder: () => [focused()!].filter(Boolean),
    isSelecting: () => false,
    adjustmentFor: (id: AssetId) => modelFor(id),
    updateAdjustment: (id: AssetId, patch: Partial<AdjustmentModel>) => {
      modelFor(id).update((m) => ({ ...m, ...patch }));
    },
    selectAsset: vi.fn(),
    bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
    seedAsShotWhiteBalance: vi.fn(),
    updateAssetDimensions: vi.fn(),
    openDownloadProgress: signal(null),
    flushPendingXmpWrites: vi.fn(),
    flushPendingPreviewWrites: vi.fn(),
    hydrateSelfHostedFsAsset: vi.fn(() => null),
    openSelfHostedSubfolder: vi.fn(),
  } as unknown as Partial<LibraryStateService>;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [EditorShellComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      XmpSerializerService,
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: LibraryStateService, useValue: stateStub },
      { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      {
        provide: RawPipelineService,
        useValue: {
          decode: vi.fn(() =>
            Promise.resolve({
              width: 800,
              height: 533,
              nativeWidth: 6240,
              nativeHeight: 4160,
              rgb: new Uint8Array([0x80, 0x80, 0x80]),
              asShotTemperature: 5200,
              asShotTint: 0,
            }),
          ),
          deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
        },
      },
    ],
  });

  TestBed.inject(ImageCanvasService);
  TestBed.inject(EditorStateService).bind(RENDER_ASSET_ID);
  TestBed.inject(CropSessionService);

  const fixture = TestBed.createComponent(EditorShellComponent);
  fixture.detectChanges();
  return fixture;
}

describe('EditorShellComponent — phone two-card layout (#1807 Task 5)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function phoneCard(fixture: ComponentFixture<EditorShellComponent>): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector(
      '.phone-card-anchor pro-control-card .card',
    );
  }

  function dockButton(
    fixture: ComponentFixture<EditorShellComponent>,
    label: string,
  ): HTMLButtonElement {
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('pro-tool-dock button'),
    ) as HTMLButtonElement[];
    const btn = buttons.find((b) => b.getAttribute('aria-label') === label);
    expect(btn, `dock button "${label}" must be present`).not.toBeNull();
    return btn!;
  }

  it('shows the phone slider panel without requiring a dock tap', () => {
    const fixture = renderShell({ layout: 'phone' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.phone-card-anchor pro-control-card .card')).toBeTruthy();
    expect(el.querySelector('.close-btn')).toBeNull();
  });

  // Review round 1 (Critical): the always-visible card and the Curve/
  // Presets/Noise panels float in the SAME anchor slot on phone (unlike
  // tablet/desktop, where those panels live in the separate dock-side
  // column and can never overlap the control card) — so the card must hide
  // while any of the three is open, or two glass panels render on top of
  // each other.
  it('hides the card while the Curve panel is open, and restores it when Curve closes', () => {
    const fixture = renderShell({ layout: 'phone' });
    expect(phoneCard(fixture)).not.toBeNull();

    dockButton(fixture, 'Tone Curve').click();
    fixture.detectChanges();

    expect(phoneCard(fixture)).toBeNull();
    expect(fixture.nativeElement.querySelector('.phone-curve-panel')).not.toBeNull();

    dockButton(fixture, 'Tone Curve').click();
    fixture.detectChanges();

    expect(phoneCard(fixture)).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.phone-curve-panel')).toBeNull();
  });

  it('hides the card while the Presets panel is open', () => {
    const fixture = renderShell({ layout: 'phone' });
    expect(phoneCard(fixture)).not.toBeNull();

    dockButton(fixture, 'Presets').click();
    fixture.detectChanges();

    expect(phoneCard(fixture)).toBeNull();
    expect(fixture.nativeElement.querySelector('.phone-presets-panel')).not.toBeNull();
  });

  it('hides the card while Noise is armed', () => {
    const fixture = renderShell({ layout: 'phone' });
    const editorState = TestBed.inject(EditorStateService);
    expect(phoneCard(fixture)).not.toBeNull();

    editorState.armTool('noise');
    fixture.detectChanges();

    expect(phoneCard(fixture)).toBeNull();
    expect(fixture.nativeElement.querySelector('.phone-subparam-panel')).not.toBeNull();
  });

  // HSL/bwMix/colorGrade are the one group of tools that DO belong inside
  // the card (#1807 Task 4 projects their body into it via
  // cardBodySubParam/cardBodyGrade) — arming any of them must NOT hide it.
  it('does not hide the card while HSL, B&W, or Color Grading is armed — they render inside it', () => {
    const fixture = renderShell({ layout: 'phone' });
    const editorState = TestBed.inject(EditorStateService);

    editorState.armTool('hsl');
    fixture.detectChanges();
    expect(phoneCard(fixture)).not.toBeNull();

    editorState.armTool('bwMix');
    fixture.detectChanges();
    expect(phoneCard(fixture)).not.toBeNull();

    editorState.armTool('colorGrade');
    fixture.detectChanges();
    expect(phoneCard(fixture)).not.toBeNull();
  });
});
