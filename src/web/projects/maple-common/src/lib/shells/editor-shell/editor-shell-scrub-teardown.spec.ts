// The canvas scrub's claim on its pointer ends with the component's own
// teardown paths (#5816): leaving the editor, and a new focused asset taking
// over a scrub still in flight. Full component, so removing either
// `cleanupScrub` call in EditorShellComponent fails here.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';

import { EditorShellComponent } from './editor-shell.component';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
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
const OTHER_ASSET: Asset = {
  id: 'library:2026/b.dng' as AssetId,
  filename: 'b.dng',
  width: 6240,
  height: 4160,
} as Asset;

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

describe('EditorShellComponent — the canvas scrub claim (#5816)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;
  let svc: ImageCanvasService;

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

    const capabilities = new LensCorrectionCapabilities();
    const stateStub = {
      resetAutoFit: capabilities.resetAutoFit.bind(capabilities),
      autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
      backend: 'self-hosted',
      focusedAsset: focused,
      focusedAssetId: () => focused()?.id ?? null,
      assets: () => [focused()!].filter(Boolean),
      assetsInSelectedFolder: () => [focused()!].filter(Boolean),
      isSelecting: () => false,
      adjustmentFor: (id: AssetId) => modelFor(id),
      asShotWbFor: () => null,
      updateAdjustment: (id: AssetId, patch: Partial<AdjustmentModel>) => {
        modelFor(id).update((m) => ({ ...m, ...patch }));
      },
      selectAsset: vi.fn(),
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      seedLensCorrections: vi.fn(),
      seedLensProfile: vi.fn(),
      lensCorrectionsFor: vi.fn(() => ({ hasLensCorrections: true, lensCorrectionCaInert: false })),
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
        XmpSerializerService,
        { provide: ActivatedRoute, useValue: route },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          useValue: {
            // #1153: the canvas template reads the deep-denoise progress signal.
            closeNativeDetail: vi.fn(),
            deepDenoiseProgress: signal(null),
            // #3397: the canvas reads this to publish out-of-band scope samples.
            scopeSample: signal(null),
            lensProfileStatus: signal(null),
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
    svc = TestBed.inject(ImageCanvasService);
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

  function startScrub(pointerId: number): void {
    const wrap = fixture.componentInstance.canvasWrapRef!.nativeElement;
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(event, 'target', { value: wrap });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    Object.defineProperty(event, 'isPrimary', { value: true });
    fixture.componentInstance.onCanvasPointerDown(event as PointerEvent);
  }

  it('a scrub in flight owns its pointer', () => {
    startScrub(1);
    expect(svc.isEditOwnedPointer(1)).toBe(true);
  });

  it('destroying the editor releases the claim', () => {
    startScrub(1);
    fixture.destroy();
    expect(svc.isEditOwnedPointer(1)).toBe(false);
  });

  it('focusing another asset mid-scrub releases the claim', () => {
    startScrub(1);
    focused.set(OTHER_ASSET);
    fixture.detectChanges();
    expect(svc.isEditOwnedPointer(1)).toBe(false);
  });
});
