// The zoom model and the draw size the photo by one extent and one fit rule
// (#5746), so only pointer motion changes what is on screen: a pinch's first
// frame continues from the fitted photo, and a bitmap landing never resizes it.
// Runs the real `raw_wasm_canvas` module through the component's wiring.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import * as rawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasService } from './image-canvas.service';
import { installCanvasZoomWasm } from './image-canvas.zoom-wasm';
import { resolveCanvasImageExtent } from './image-canvas.crop';
import { LibraryStateService } from '../../state/library-state.service';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import {
  CROP_IDENTITY,
  defaultAdjustmentModel,
  type AdjustmentModel,
} from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

beforeAll(() => {
  const output = rawWasm.initSync({
    module: readFileSync(
      resolve(
        process.cwd(),
        'projects/maple-common/src/lib/raw-pipeline/pkg/canvas/raw_wasm_canvas_bg.wasm',
      ),
    ),
  });
  installCanvasZoomWasm(rawWasm, output.memory);
});

describe('one image extent for the zoom model and the draw (#5746)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let canvasSvc: ImageCanvasService;
  let fixture: ComponentFixture<ImageCanvasComponent>;
  let dpr: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    focused = signal<Asset | null>(null);
    models = new Map();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const capabilities = new LensCorrectionCapabilities();
    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: (id: AssetId) => {
        if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
        return models.get(id)!;
      },
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      resetAutoFit: capabilities.resetAutoFit.bind(capabilities),
      seedLensCorrections: capabilities.seed.bind(capabilities),
      autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
      seedLensProfile: capabilities.seedProfile.bind(capabilities),
      lensCorrectionsFor: (id: string) => capabilities.for(id),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          useValue: {
            closeNativeDetail: vi.fn(),
            deepDenoiseProgress: signal(null),
            scopeSample: signal(null),
            // The decode never answers: each case publishes the native size
            // and the painted bitmap itself, in the order it is about.
            decode: vi.fn(() => new Promise(() => {})),
          },
        },
      ],
    });
    canvasSvc = TestBed.inject(ImageCanvasService);
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
    fixture.componentInstance.wrapW.set(1200);
    fixture.componentInstance.wrapH.set(800);
  });

  afterEach(() => {
    fixture.destroy();
    if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr);
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function open(asset: Partial<Asset>): Promise<void> {
    focused.set({ id: 'a', filename: 'a.dng', ...asset } as Asset);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  function drawnWidth(): number {
    fixture.detectChanges();
    return canvasSvc.effectivePx()?.canvasW ?? NaN;
  }

  function pointer(type: string, pointerId: number, clientX: number): void {
    const wrap = fixture.nativeElement.querySelector('.canvas-wrap') as HTMLElement;
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 400 });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    wrap.dispatchEvent(event);
  }

  const FIRST_FRAME_MAGNIFICATION = 1.001;
  /** The first frame of a two-finger pinch about the wrap centre. */
  function firstPinchFrame(): void {
    pointer('pointerdown', 1, 500);
    pointer('pointerdown', 2, 700);
    pointer('pointermove', 2, 700.2);
  }

  it('a small image: the first pinch frame continues from the fitted size', async () => {
    await open({ filename: 'a.jpg', width: 800, height: 600 });
    canvasSvc.nativeDimensions.set({ w: 800, h: 600 });
    canvasSvc.paintedAspect.set({ w: 800, h: 600 });
    const fittedWidth = (800 * 800) / 600;
    expect(drawnWidth()).toBe(Math.round(fittedWidth));
    expect(fixture.componentInstance.zoomLabel()).toBe('267%');
    firstPinchFrame();
    expect(drawnWidth()).toBe(Math.round(fittedWidth * FIRST_FRAME_MAGNIFICATION));
  });

  it('a pinch before the native size lands continues from the fitted size, and the landing keeps it', async () => {
    await open({ width: 6000, height: 4000 });
    canvasSvc.paintedAspect.set({ w: 1600, h: 1067 });
    expect(drawnWidth()).toBe(1200);
    firstPinchFrame();
    const pinched = Math.round(1200 * FIRST_FRAME_MAGNIFICATION);
    expect(drawnWidth()).toBe(pinched);
    canvasSvc.nativeDimensions.set({ w: 6000, h: 4000 });
    expect(drawnWidth()).toBe(pinched);
  });

  it('with a crop applied, a fast or refine landing never resizes the photo', async () => {
    await open({ width: 6000, height: 4000 });
    models.get('a')!.set({
      ...defaultAdjustmentModel(),
      crop: { ...CROP_IDENTITY, left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 },
    });
    canvasSvc.nativeDimensions.set({ w: 6000, h: 4000 });
    canvasSvc.paintedAspect.set({ w: 2400, h: 1600 });
    canvasSvc.pixelScale.set(1);
    const shown = drawnWidth();
    expect(shown).toBe(2400);
    canvasSvc.paintedAspect.set({ w: 3000, h: 2000 });
    expect(drawnWidth()).toBe(shown);
  });
});

describe('resolveCanvasImageExtent', () => {
  const base = {
    painted: null,
    native: null,
    assetW: undefined,
    assetH: undefined,
    crop: CROP_IDENTITY,
    cropToolActive: false,
  };
  const crop = { ...CROP_IDENTITY, right: 0.5 };

  it('is the native size, cropped by an applied crop', () => {
    expect(resolveCanvasImageExtent({ ...base, native: { w: 6000, h: 4000 } })).toEqual({
      w: 6000,
      h: 4000,
    });
    expect(resolveCanvasImageExtent({ ...base, native: { w: 6000, h: 4000 }, crop })).toEqual({
      w: 3000,
      h: 4000,
    });
  });

  it('ignores the crop while the crop tool shows the full frame', () => {
    const extent = { ...base, native: { w: 6000, h: 4000 }, crop, cropToolActive: true };
    expect(resolveCanvasImageExtent(extent)).toEqual({ w: 6000, h: 4000 });
  });

  it('falls back to the stored size, then to the painted bitmap', () => {
    const stored = { ...base, assetW: 6000, assetH: 4000, painted: { w: 1600, h: 1067 } };
    expect(resolveCanvasImageExtent(stored)).toEqual({ w: 6000, h: 4000 });
    expect(resolveCanvasImageExtent({ ...base, painted: { w: 1600, h: 1067 } })).toEqual({
      w: 1600,
      h: 1067,
    });
    expect(resolveCanvasImageExtent(base)).toBeNull();
  });

  it('turns an unoriented stored size a quarter to match what was painted', () => {
    const unoriented = { ...base, assetW: 4000, assetH: 6000, painted: { w: 1600, h: 1067 } };
    expect(resolveCanvasImageExtent(unoriented)).toEqual({ w: 6000, h: 4000 });
  });

  it('keeps only the painted shape while a crop render is pending, at the image scale', () => {
    const cropPending = {
      ...base,
      native: { w: 6000, h: 4000 },
      crop,
      painted: { w: 1600, h: 1067 },
    };
    const extent = resolveCanvasImageExtent(cropPending);
    expect(extent?.w).toBe(4000);
    expect(extent?.h).toBeCloseTo(4000 / (1600 / 1067), 9);
  });
});
