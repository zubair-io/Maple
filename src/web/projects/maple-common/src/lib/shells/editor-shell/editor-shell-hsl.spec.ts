// editor-shell-hsl.spec.ts — canvas-first editor (A) HSL / color-mix port
// (epic #1807 slice 4).
//
// A had no way to arm HSL: no dock entry, no sub-param editing surface of
// its own. HSL's 24 sub-params (hue/saturation/luminance × 8 color bands)
// don't fit the control card's simple LivingSlider grid (control-
// card.component.ts's SLIDER_TOOLS deliberately excludes 'hsl'), so this
// spec proves the port reuses the SAME shared multi-param machinery the S5
// editor (B) already ships with #1112 — SubParamRowComponent (chip
// selector), DragBarComponent, ValueChipComponent, and
// EditorStateService.armSubParam/setArmedDisplayValue — rather than
// reinventing sub-param arming or value mapping:
//
//   - the tool dock's HSL entry arms EditorStateService.armedTool = 'hsl'
//   - the shared chip row, drag bar, and value chip all mount in the DOM
//     (verbatim, no editor-A-specific inputs)
//   - selecting a chip arms that (tool, subParam) pair via
//     EditorStateService.armSubParam — the SAME state B's chip row drives
//   - a drag-bar edit writes the exact AdjustmentModel field the armed
//     sub-param declares (e.g. hueAdjustmentRed / hueAdjustmentOrange)
//   - HSL, Crop, Curve, and Presets share one panel anchor and are mutually
//     exclusive, extending the guards `editor-shell-crop.spec.ts` /
//     `editor-shell-presets.spec.ts` locked down.
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

describe('EditorShellComponent — HSL / color-mix port (epic #1807 slice 4)', () => {
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
      flushPendingPreviewWrites: vi.fn(),
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
        // Hosted backend so PresetsService (mounted by the shell for the
        // mutual-exclusion checks below) uses the IndexedDB user-preset
        // store rather than issuing HTTP calls the harness doesn't stub.
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
        {
          provide: RawPipelineService,
          useValue: {
            // #1153: the canvas template reads the deep-denoise progress signal.
            deepDenoiseProgress: signal(null),
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

  function hslDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="HSL"]',
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

  function presetsDockButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Presets"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function hslPanel(): Element | null {
    return fixture.nativeElement.querySelector('.hsl-panel');
  }

  function curvePanel(): Element | null {
    return fixture.nativeElement.querySelector('.curve-panel');
  }

  function presetsPanel(): Element | null {
    return fixture.nativeElement.querySelector('.presets-panel');
  }

  it('dock renders an HSL entry with an accessible label', () => {
    const btn = hslDockButton();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('HSL');
  });

  it('does NOT mount the HSL panel for a non-HSL tool', () => {
    expect(hslPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('clicking the HSL dock entry arms the tool and mounts the shared sub-param editing surface', () => {
    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedTool()).not.toBe('hsl');

    hslDockButton().click();
    fixture.detectChanges();

    expect(editorState.armedTool()).toBe('hsl');
    expect(editorState.armedGroup()).toBe('color');

    // The shared chip row, drag bar, and value chip (verbatim S5 components,
    // #1112) are now in the DOM.
    expect(hslPanel()).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="editor-subparam-row"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="editor-drag-bar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="editor-value-chip"]')).not.toBeNull();

    // First sub-param (Hue Red) is armed by default.
    expect(editorState.armedSubParamId()).toBe('hueRed');

    // The control card (living sliders) is hidden while HSL is armed — HSL
    // has no single primary drag-bar field, matching Crop's control-card
    // hiding.
    expect(fixture.nativeElement.querySelector('pro-control-card')).toBeNull();
  });

  it('HSL highlights active in the dock while armed, and Color does not', () => {
    hslDockButton().click();
    fixture.detectChanges();

    expect(hslDockButton().classList.contains('dock-btn--active')).toBe(true);
    const colorBtn = fixture.nativeElement.querySelector(
      'pro-tool-dock button[aria-label="Color"]',
    ) as HTMLButtonElement;
    expect(colorBtn.classList.contains('dock-btn--active')).toBe(false);
  });

  it('selecting a chip arms that (tool, subParam) pair via EditorStateService.armSubParam', () => {
    hslDockButton().click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedSubParamId()).toBe('hueRed');

    const orangeChip = fixture.nativeElement.querySelector(
      '[data-testid="editor-subparam-hueOrange"]',
    ) as HTMLButtonElement | null;
    expect(orangeChip).not.toBeNull();

    orangeChip!.click();
    fixture.detectChanges();

    expect(editorState.armedSubParamId()).toBe('hueOrange');
    expect(orangeChip!.classList.contains('armed')).toBe(true);
  });

  it('a drag-bar edit on the default-armed sub-param writes hueAdjustmentRed', () => {
    hslDockButton().click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedSubParamId()).toBe('hueRed');

    const before = modelFor(ASSET_ID)();
    expect(before.hueAdjustmentRed).toBe(0);

    // Drive the value pipe directly (mirrors the drag-bar's pointer-move
    // handler, which calls the same EditorStateService method) — the
    // drag-bar's own pointer geometry is exercised by drag-bar-math.spec.ts
    // and editor.component.spec.ts already; this proves the SAME method
    // wired through THIS shell writes the expected field.
    editorState.commit();
    editorState.setArmedInternalValue(40);
    fixture.detectChanges();

    const after = modelFor(ASSET_ID)();
    expect(after.hueAdjustmentRed).toBeCloseTo(40, 5);
    // Only the armed field changed — the shape a real drag writes.
    expect(after.hueAdjustmentOrange).toBe(0);
  });

  it('after arming a different sub-param, a value edit writes THAT field, not the default one', () => {
    hslDockButton().click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    const orangeChip = fixture.nativeElement.querySelector(
      '[data-testid="editor-subparam-hueOrange"]',
    ) as HTMLButtonElement;
    orangeChip.click();
    fixture.detectChanges();

    editorState.commit();
    editorState.setArmedInternalValue(-25);
    fixture.detectChanges();

    const after = modelFor(ASSET_ID)();
    expect(after.hueAdjustmentOrange).toBeCloseTo(-25, 5);
    expect(after.hueAdjustmentRed).toBe(0);
  });

  it('the value chip reflects the armed sub-param label', () => {
    hslDockButton().click();
    fixture.detectChanges();

    const subParamEyebrow = fixture.nativeElement.querySelector(
      '[data-testid="editor-value-chip-subparam"]',
    );
    expect(subParamEyebrow).not.toBeNull();
    expect(subParamEyebrow!.textContent.trim()).toBe('H RED');

    const orangeChip = fixture.nativeElement.querySelector(
      '[data-testid="editor-subparam-hueOrange"]',
    ) as HTMLButtonElement;
    orangeChip.click();
    fixture.detectChanges();

    const updatedEyebrow = fixture.nativeElement.querySelector(
      '[data-testid="editor-value-chip-subparam"]',
    );
    expect(updatedEyebrow!.textContent.trim()).toBe('H ORANGE');
  });

  // ── HSL / Curve / Crop / Presets mutual exclusion (extends the guards
  // editor-shell-crop.spec.ts / editor-shell-presets.spec.ts locked down for
  // the other panel pairs sharing this anchor) ─────────────────────────────

  it('arming HSL closes an open Curve panel', () => {
    curveDockButton().click();
    fixture.detectChanges();
    expect(curvePanel()).not.toBeNull();

    hslDockButton().click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(hslPanel()).not.toBeNull();
  });

  it('arming HSL closes an open Presets panel', () => {
    presetsDockButton().click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    hslDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(hslPanel()).not.toBeNull();
  });

  it('toggling Curve while HSL is armed is a no-op — the curve panel never opens over the HSL panel', () => {
    hslDockButton().click();
    fixture.detectChanges();
    expect(hslPanel()).not.toBeNull();

    curveDockButton().click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('hsl');
    expect(hslPanel()).not.toBeNull();
  });

  it('toggling Presets while HSL is armed is a no-op — the presets panel never opens over the HSL panel', () => {
    hslDockButton().click();
    fixture.detectChanges();
    expect(hslPanel()).not.toBeNull();

    presetsDockButton().click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('hsl');
    expect(hslPanel()).not.toBeNull();
  });

  it('arming Crop closes an open HSL panel', () => {
    hslDockButton().click();
    fixture.detectChanges();
    expect(hslPanel()).not.toBeNull();

    cropDockButton().click();
    fixture.detectChanges();

    expect(hslPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  it('arming HSL closes an active Crop session', () => {
    cropDockButton().click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();

    hslDockButton().click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).toBeNull();
    expect(hslPanel()).not.toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('hsl');
  });
});
