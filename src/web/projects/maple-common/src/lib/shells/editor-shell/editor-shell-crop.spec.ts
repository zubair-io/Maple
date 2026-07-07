// editor-shell-crop.spec.ts — canvas-first editor (A) crop port (#1813).
//
// A had no way to arm Crop: no dock entry, no toolbar, no overlay-mounting
// wiring of its own. This spec proves the port reuses the SAME shared
// machinery the S5 editor (B) already ships with #638 — CropSessionService,
// CropOverlayComponent (mounted inside the shared ImageCanvasComponent), and
// CropToolbarComponent — rather than reinventing crop state or math:
//
//   - the tool dock's Crop entry arms EditorStateService.armedTool = 'crop'
//   - CropSessionService.active flips true (it derives from armedTool alone,
//     so no editor-specific plumbing is needed for this step)
//   - the crop toolbar panel + the shared crop overlay both mount in the DOM
//   - a crop edit through the SAME toolbar/overlay code path writes the SAME
//     AdjustmentModel.crop shape B's commit chain writes — a straighten drag
//     round-trips through LibraryStateService.updateAdjustment.
//
// Full template render (not just class instantiation, unlike the route-
// resolution spec in editor-shell.component.spec.ts) so the dock → overlay →
// toolbar DOM wiring is actually exercised. Follows the ImageCanvasComponent
// spec's stubbing pattern (ResizeObserver/ImageData/createImageBitmap +
// RawPipelineService.decode stub) since editor-image-canvas is mounted here
// too — see image-canvas.component.spec.ts for the precedent.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';

import { EditorShellComponent } from './editor-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { CropSessionService } from '../../components/crop-overlay/crop-session.service';
import {
  defaultAdjustmentModel,
  isIdentityCrop,
  type AdjustmentModel,
} from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

const ASSET_ID = 'library:2026/a.dng' as AssetId;

function stubGlobals(): void {
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

describe('EditorShellComponent — crop tool port (#1813)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    stubGlobals();

    models = new Map();
    focused = signal<Asset | null>({
      id: ASSET_ID,
      filename: 'a.dng',
      width: 6240,
      height: 4160,
    } as Asset);

    const route = {
      url: of([]),
      snapshot: { paramMap: convertToParamMap({}), url: [] },
    };

    const stateStub = {
      backend: 'self-hosted',
      focusedAsset: focused,
      focusedAssetId: () => focused()?.id ?? null,
      assets: () => [focused()!].filter(Boolean),
      assetsInSelectedFolder: () => [focused()!].filter(Boolean),
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
      hydrateSelfHostedFsAsset: vi.fn(() => null),
      openSelfHostedSubfolder: vi.fn(),
    } as unknown as Partial<LibraryStateService>;

    TestBed.configureTestingModule({
      imports: [EditorShellComponent],
      providers: [
        XmpSerializerService,
        { provide: ActivatedRoute, useValue: route },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: LibraryStateService, useValue: stateStub },
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
          },
        },
      ],
    });

    // Real singletons under test: ImageCanvasService (pan/zoom), EditorStateService
    // (arming), CropSessionService (derives `active` from EditorStateService).
    TestBed.inject(ImageCanvasService);
    TestBed.inject(EditorStateService).bind(ASSET_ID);
    TestBed.inject(CropSessionService);

    fixture = TestBed.createComponent(EditorShellComponent);
    // Force the tablet/desktop breakpoint so the dock renders (jsdom's
    // default innerWidth is 1024, already ≥768, but the resize handler needs
    // a first tick — detectChanges runs ngOnInit/ngAfterViewInit).
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function cropDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Crop"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function curveDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Curve"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function curvePanel(): Element | null {
    return fixture.nativeElement.querySelector('.curve-panel');
  }

  it('dock renders a Crop entry with an accessible label', () => {
    const btn = cropDockButton();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Crop');
  });

  it('arms the Crop tool and mounts the shared overlay + toolbar when the dock entry is clicked', () => {
    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedTool()).not.toBe('crop');

    cropDockButton().click();
    fixture.detectChanges();

    expect(editorState.armedTool()).toBe('crop');
    expect(editorState.armedGroup()).toBe('detail');

    // CropSessionService.active is derived purely from armedTool — confirms
    // the shared session (also used by the S5 editor) sees A's arming.
    const cropSession = TestBed.inject(CropSessionService);
    expect(cropSession.active()).toBe(true);

    // The shared interactive overlay (already mounted inside
    // ImageCanvasComponent for both editors) is now in the DOM.
    const overlay = fixture.nativeElement.querySelector('editor-crop-overlay');
    expect(overlay).not.toBeNull();

    // A's crop-toolbar panel (aspect/straighten/reset/done) is mounted.
    const toolbar = fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]');
    expect(toolbar).not.toBeNull();

    // The control card (living sliders) is hidden while cropping — the crop
    // toolbar is the only control surface, matching the S5 editor swapping
    // its drag-bar area for the crop toolbar while armed.
    const controlCard = fixture.nativeElement.querySelector('pro-control-card');
    expect(controlCard).toBeNull();
  });

  it('does NOT mount the crop overlay/toolbar for a non-crop tool', () => {
    const overlay = fixture.nativeElement.querySelector('editor-crop-overlay');
    const toolbar = fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]');
    expect(overlay).toBeNull();
    expect(toolbar).toBeNull();
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('a straighten commit through the shared toolbar writes AdjustmentModel.crop — same shape B writes', () => {
    cropDockButton().click();
    fixture.detectChanges();

    const before = modelFor(ASSET_ID)();
    expect(isIdentityCrop(before.crop)).toBe(true);

    const slider = fixture.nativeElement.querySelector(
      '[data-testid="crop-straighten"]',
    ) as HTMLInputElement | null;
    expect(slider).not.toBeNull();

    slider!.value = '12.5';
    slider!.dispatchEvent(new Event('pointerdown'));
    slider!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const after = modelFor(ASSET_ID)();
    // Exact shape LibraryStateService.updateAdjustment received: only `crop`
    // changed, angle set, all other crop fields untouched (still identity
    // top/left/bottom/right) — the same partial-patch shape
    // CropToolbarComponent.onStraighten produces for the S5 editor.
    expect(after.crop.angle).toBeCloseTo(12.5, 5);
    expect(after.crop.top).toBe(0);
    expect(after.crop.left).toBe(0);
    expect(after.crop.bottom).toBe(1);
    expect(after.crop.right).toBe(1);
    expect(isIdentityCrop(after.crop)).toBe(false);
  });

  it('Done exits crop back to Exposure and restores the control card', () => {
    cropDockButton().click();
    fixture.detectChanges();

    const doneBtn = fixture.nativeElement.querySelector(
      '[data-testid="crop-done"]',
    ) as HTMLButtonElement | null;
    expect(doneBtn).not.toBeNull();
    doneBtn!.click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedTool()).toBe('exposure');
    expect(fixture.nativeElement.querySelector('editor-crop-overlay')).toBeNull();
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('Reset restores the identity crop', () => {
    cropDockButton().click();
    fixture.detectChanges();

    modelFor(ASSET_ID).update((m) => ({
      ...m,
      crop: { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5 },
    }));
    fixture.detectChanges();

    const resetBtn = fixture.nativeElement.querySelector(
      '[data-testid="crop-reset"]',
    ) as HTMLButtonElement | null;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn!.disabled).toBe(false);

    resetBtn!.click();
    fixture.detectChanges();

    expect(isIdentityCrop(modelFor(ASSET_ID)().crop)).toBe(true);
  });

  // ── Curve / Crop mutual exclusion (#1814 Copilot review) ─────────────────
  // Both panels share the same absolute anchor (`right: 64px; top: 50%`), so
  // they must never render at once. Crop wins while armed.

  it('arming Crop closes an open curve panel', () => {
    // Open the curve panel first.
    curveDockButton().click();
    fixture.detectChanges();
    expect(curvePanel()).not.toBeNull();

    // Arming Crop must auto-close it so the two panels can't overlap.
    cropDockButton().click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  it('toggling Curve while cropping is a no-op — the curve panel never opens over the crop toolbar', () => {
    cropDockButton().click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
    expect(curvePanel()).toBeNull();

    // Tapping Curve while crop is armed must not open the curve panel.
    curveDockButton().click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    // Crop is still armed + its toolbar still shown (Curve didn't disturb it).
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('crop');
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });
});
