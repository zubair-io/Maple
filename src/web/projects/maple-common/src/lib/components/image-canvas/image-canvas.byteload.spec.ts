// #1562: browse-opened backend assets take the async byte-fetch path.
//
// M2 unified addressing (#1325) keys assets by `slug:relPath` (MapleAddress) and
// no longer populates the legacy `absPath`. The decode effect used to gate its
// async `bytesForAsset` fetch on `absPath` alone, so every browse-opened backend
// asset fell through to the mock-gradient branch and never decoded. The gate now
// also accepts a MapleAddress id (always contains ':'); mock/import ids never do.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { Asset } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

const REFINE_MS = 150;
const NATIVE_W = 4000;
const NATIVE_H = 2500;

function decodedAt(maxLongEdge: number): DecodedImage {
  const long = Math.min(maxLongEdge, NATIVE_W);
  const w = long;
  const h = Math.max(1, Math.round((long * NATIVE_H) / NATIVE_W));
  return {
    width: w,
    height: h,
    nativeWidth: NATIVE_W,
    nativeHeight: NATIVE_H,
    rgb: new Uint8Array([0x80, 0x80, 0x80]),
    asShotTemperature: 5200,
    asShotTint: 0,
  };
}

describe('ImageCanvasComponent — async byte-fetch gate (#1562)', () => {
  let focused: WritableSignal<Asset | null>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let bytesForAssetSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    decodeSpy = vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
      Promise.resolve(decodedAt(mle)),
    );
    bytesForAssetSpy = vi.fn(() => Promise.resolve(new Uint8Array([0x44, 0x4e, 0x47])));
    const model = signal(defaultAdjustmentModel());

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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

    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: () => model,
      // No in-memory bytes — the browse/backend case forces the async path.
      bytesFor: () => undefined,
      bytesForAsset: bytesForAssetSpy,
      seedAsShotWhiteBalance: vi.fn(),
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
          // #1153: the canvas template reads the deep-denoise progress signal.
          useValue: { decode: decodeSpy, deepDenoiseProgress: signal(null) },
        },
      ],
    });
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('fetches + decodes a MapleAddress-backed asset that has no absPath', async () => {
    // `slug:relPath` id with no absPath — exactly what Browse hands the editor.
    focused.set({ id: 'photos:2026/trip/a.dng', filename: 'a.dng' } as Asset);
    await settle(REFINE_MS + 50);

    expect(bytesForAssetSpy).toHaveBeenCalledWith('photos:2026/trip/a.dng');
    // The fetched bytes reach the decoder → the image renders (not the gradient).
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a mock asset (no colon, no absPath) on the gradient path', async () => {
    focused.set({ id: 'a-film', filename: 'a-film.dng' } as Asset);
    await settle(REFINE_MS + 50);

    expect(bytesForAssetSpy).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
  });
});
