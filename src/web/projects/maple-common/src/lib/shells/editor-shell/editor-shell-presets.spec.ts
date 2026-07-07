// editor-shell-presets.spec.ts — canvas-first editor (A) presets port (#1815).
//
// A had no way to open the presets panel: no dock entry, no panel-mount
// wiring of its own. This spec proves the port reuses the SAME shared
// machinery the S5 editor (B) already ships with #1115 — `PresetsService`
// (root-provided, editor-agnostic) and `EditorStateService.applyPreset` —
// rather than reinventing preset storage or apply semantics:
//
//   - the tool dock's Presets entry toggles a local `presetsOpen` signal
//   - the shared `PresetsPanelComponent` mounts in the DOM (verbatim, no
//     editor-A-specific inputs)
//   - applying a built-in preset routes through the SAME
//     `EditorStateService.applyPreset` → `LibraryStateService.updateAdjustment`
//     path B's presets pill uses
//   - Presets, Curve, and Crop share one panel anchor and are mutually
//     exclusive, extending the guards `editor-shell-crop.spec.ts` locked
//     down for Curve/Crop.
//
// Full template render (not just class instantiation) so the dock → panel
// DOM wiring is actually exercised. Follows `editor-shell-crop.spec.ts`'s
// stubbing pattern (ResizeObserver/ImageData/createImageBitmap +
// RawPipelineService.decode stub) since editor-image-canvas is mounted here
// too.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { PresetsService } from '../../editor/presets/presets.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
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

describe('EditorShellComponent — presets port (#1815)', () => {
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
        provideHttpClient(),
        provideHttpClientTesting(),
        XmpSerializerService,
        { provide: ActivatedRoute, useValue: route },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: LibraryStateService, useValue: stateStub },
        // Hosted backend so PresetsService uses the IndexedDB user-preset
        // store rather than issuing HTTP calls the harness doesn't stub.
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

  function presetsDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Presets"]',
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

  function cropDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Crop"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function presetsPanel(): Element | null {
    return fixture.nativeElement.querySelector('.presets-panel');
  }

  function curvePanel(): Element | null {
    return fixture.nativeElement.querySelector('.curve-panel');
  }

  it('dock renders a Presets entry with an accessible label', () => {
    const btn = presetsDockButton();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Presets');
  });

  it('clicking the Presets dock entry mounts the shared presets panel', () => {
    expect(presetsPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('app-presets-panel')).toBeNull();

    presetsDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-presets-panel')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="presets-panel"]')).not.toBeNull();
  });

  it('clicking Presets again closes the panel (toggle)', () => {
    presetsDockButton().click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    presetsDockButton().click();
    fixture.detectChanges();
    expect(presetsPanel()).toBeNull();
  });

  it('applying a built-in preset routes through EditorStateService.applyPreset', () => {
    presetsDockButton().click();
    fixture.detectChanges();

    const before = modelFor(ASSET_ID)();
    expect(before.contrast).toBe(0);

    // "Flat" built-in preset sets contrast: -50 (builtin-presets.ts).
    const applyBtn = fixture.nativeElement.querySelector(
      '[data-testid="preset-apply-builtin-flat"]',
    ) as HTMLButtonElement | null;
    expect(applyBtn).not.toBeNull();

    applyBtn!.click();
    fixture.detectChanges();

    const after = modelFor(ASSET_ID)();
    expect(after.contrast).toBe(-50);

    // Applying closes the panel (the panel's `applied` output).
    expect(presetsPanel()).toBeNull();
  });

  // ── Presets / Curve / Crop mutual exclusion (mirrors #1814's Curve/Crop
  // guards, extended to the third panel sharing the same anchor) ──────────

  it('opening Presets closes an open Curve panel', () => {
    curveDockButton().click();
    fixture.detectChanges();
    expect(curvePanel()).not.toBeNull();

    presetsDockButton().click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(presetsPanel()).not.toBeNull();
  });

  it('opening Curve closes an open Presets panel', () => {
    presetsDockButton().click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    curveDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(curvePanel()).not.toBeNull();
  });

  it('arming Crop closes an open Presets panel', () => {
    presetsDockButton().click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    cropDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  it('toggling Presets while cropping is a no-op — the presets panel never opens over the crop toolbar', () => {
    cropDockButton().click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();

    presetsDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('crop');
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  it('Presets highlights active in the dock while open', () => {
    presetsDockButton().click();
    fixture.detectChanges();

    expect(presetsDockButton().classList.contains('dock-btn--active')).toBe(true);
    expect(curveDockButton().classList.contains('dock-btn--active')).toBe(false);
  });
});
