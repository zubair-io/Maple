// editor-shell-auto-reset.spec.ts — AUTO / RESET reachability (#2244).
//
// Epic #1370 shipped both controls, but their only host was
// `DevelopToolbarComponent` → `develop-tab` → `editor-detail-panel`, and the
// canvas-first redesign retired that chain without porting the buttons. The
// state layer stayed green the whole time, because every test called
// `EditorStateService.applyAuto()` / `.resetAll()` directly — so a service-level
// test could never have caught it.
//
// This spec therefore drives the LIVE editor route's component
// (`EditorShellComponent`, the target of `edit/:slug`) through a full template
// render and clicks the real DOM buttons. If a future redesign drops them
// again, these go red.
//
// Full template render, following the stubbing pattern shared by
// editor-shell-parity.spec.ts / editor-shell-crop.spec.ts.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

/** As-Shot white balance RESET must restore (deliberately not 6500 / 0, so a
 *  reset that only wrote `defaultAdjustmentModel()` would fail). */
const AS_SHOT = { temperature: 5200, tint: 7 };

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

function setWindowWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

describe('EditorShellComponent — AUTO / RESET reachability (#2244)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  const originalInnerWidth = window.innerWidth;

  /** The pending AUTO analysis and its resolver — each test settles it when
   *  it wants to, so the in-flight/disabled state is observable. */
  let autoPending: Promise<{ exposure: number }>;
  let autoResolve: (patch: { exposure: number }) => void;

  /** Resolve the stubbed analysis and drain the microtasks `applyAuto`'s
   *  `await` continuation and its `finally` block are queued on. */
  async function settleAuto(exposure: number): Promise<void> {
    autoResolve({ exposure });
    await autoPending;
    await Promise.resolve();
    await Promise.resolve();
  }

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  function setup(width = 1280): void {
    stubGlobals();
    setWindowWidth(width);

    models = new Map();
    const focused = signal<Asset | null>({
      id: ASSET_ID,
      filename: 'a.dng',
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
      adjustmentFor: (id: AssetId) => modelFor(id),
      updateAdjustment: (id: AssetId, patch: Partial<AdjustmentModel>) => {
        modelFor(id).update((m) => ({ ...m, ...patch }));
      },
      asShotWbFor: () => AS_SHOT,
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      selectAsset: vi.fn(),
      seedAsShotWhiteBalance: vi.fn(),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
      flushPendingXmpWrites: vi.fn(() => Promise.resolve()),
      flushPendingPreviewWrites: vi.fn(),
      hydrateSelfHostedFsAsset: vi.fn(() => null),
      openSelfHostedSubfolder: vi.fn(),
    } as unknown as Partial<LibraryStateService>;

    autoPending = new Promise<{ exposure: number }>((resolve) => {
      autoResolve = resolve;
    });

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
                asShotTemperature: AS_SHOT.temperature,
                asShotTint: AS_SHOT.tint,
              }),
            ),
            computeAutoAdjustments: vi.fn(() => autoPending),
            // #1153 added this signal to the real service and the editor reads
            // it to drive the determinate BM3D indicator. The stub has to carry
            // it or the component throws on construction — this spec and that
            // change landed against a main that did not yet contain the other.
            deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
          },
        },
      ],
    });

    TestBed.inject(ImageCanvasService);
    TestBed.inject(EditorStateService).bind(ASSET_ID);
    TestBed.inject(CropSessionService);

    fixture = TestBed.createComponent(EditorShellComponent);
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
    setWindowWidth(originalInnerWidth);
  });

  function button(testId: string): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      `[data-testid="${testId}"]`,
    ) as HTMLButtonElement | null;
    expect(btn, `${testId} must be present in the live editor`).not.toBeNull();
    return btn!;
  }

  const autoButton = () => button('editor-shell-auto');
  const resetButton = () => button('editor-shell-reset');

  // ── Reachability ───────────────────────────────────────────────────────

  describe('both controls are mounted by the live editor route component', () => {
    it('renders an enabled, labelled AUTO button on desktop', () => {
      setup(1280);
      expect(autoButton().getAttribute('aria-label')).toBe('Auto adjust');
      expect(autoButton().disabled).toBe(false);
    });

    it('renders an enabled, labelled RESET button on desktop', () => {
      setup(1280);
      expect(resetButton().getAttribute('aria-label')).toBe('Reset all adjustments');
      expect(resetButton().disabled).toBe(false);
    });

    it('keeps both reachable on phone widths (the top bar is not tablet-gated)', () => {
      setup(390);
      expect(autoButton()).toBeTruthy();
      expect(resetButton()).toBeTruthy();
    });
  });

  // ── AUTO through the button ────────────────────────────────────────────

  describe('AUTO', () => {
    beforeEach(() => setup(1280));

    it('writes exposure AND autoExposure:Off together — the epic AE contract', async () => {
      autoButton().click();
      await settleAuto(1.25);
      fixture.detectChanges();

      const m = modelFor(ASSET_ID)();
      expect(m.exposure).toBeCloseTo(1.25, 6);
      // The load-bearing invariant of #1370: AUTO's exposure is measured
      // against an AE-Off probe, so the mode must flip alongside it.
      expect(m.autoExposure).toBe('Off');
    });

    it('is disabled while the analysis is in flight', async () => {
      autoButton().click();
      fixture.detectChanges();
      expect(autoButton().disabled).toBe(true);
      expect(autoButton().getAttribute('aria-busy')).toBe('true');

      await settleAuto(0.5);
      fixture.detectChanges();
      expect(autoButton().disabled).toBe(false);
    });
  });

  // ── RESET through the button ───────────────────────────────────────────

  describe('RESET', () => {
    beforeEach(() => setup(1280));

    it('restores factory defaults, As-Shot WB and the Auto profile, keeping crop', () => {
      const crop = { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5 };
      modelFor(ASSET_ID).update((m) => ({
        ...m,
        exposure: 2,
        contrast: 40,
        saturation: -30,
        temperature: 9000,
        tint: -25,
        profile: 'Neutral',
        crop,
      }));
      fixture.detectChanges();

      resetButton().click();
      fixture.detectChanges();

      const m = modelFor(ASSET_ID)();
      const factory = defaultAdjustmentModel();
      expect(m.exposure).toBeCloseTo(factory.exposure, 6);
      expect(m.contrast).toBeCloseTo(factory.contrast, 6);
      expect(m.saturation).toBeCloseTo(factory.saturation, 6);
      expect(m.temperature).toBeCloseTo(AS_SHOT.temperature, 6);
      expect(m.tint).toBeCloseTo(AS_SHOT.tint, 6);
      expect(m.whiteBalancePreset).toBe('As Shot');
      expect(m.profile).toBe('Auto');
      // Framing is the user's, not an adjustment — RESET never touches it.
      expect(m.crop).toEqual(crop);
    });

    it('is one undo entry — undo restores the whole pre-reset model', () => {
      modelFor(ASSET_ID).update((m) => ({ ...m, exposure: 2, contrast: 40 }));
      const editorState = TestBed.inject(EditorStateService);
      fixture.detectChanges();

      resetButton().click();
      fixture.detectChanges();
      expect(editorState.canUndo()).toBe(true);

      editorState.undo();
      const m = modelFor(ASSET_ID)();
      expect(m.exposure).toBeCloseTo(2, 6);
      expect(m.contrast).toBeCloseTo(40, 6);
    });
  });
});
