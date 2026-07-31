// #2407: a byte-fetch failure must not leave a silent blank canvas. Verifies
// the overlay names the file and offers a Retry action, and that Retry
// re-attempts the fetch (clearing the error state on success).

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

describe('ImageCanvasComponent — recoverable byte-load error (#2407)', () => {
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
    bytesForAssetSpy = vi.fn();
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
      // No in-memory bytes — force the async backend-fetch path.
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

  it('renders a named, retryable error overlay when bytesForAsset rejects (no silent blank canvas)', async () => {
    bytesForAssetSpy.mockRejectedValueOnce({ status: 503, url: '/api/image/photos/trip/a.dng' });
    focused.set({ id: 'photos:2026/trip/a.dng', filename: 'a.dng' } as Asset);
    await settle(REFINE_MS + 50);

    const overlay = fixture.nativeElement.querySelector('[data-testid="byte-load-error"]');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('a.dng');
    expect(overlay.textContent).toContain('HTTP 503');
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('renders a generic network reason for statusless failures', async () => {
    bytesForAssetSpy.mockRejectedValueOnce(new Error('imageBlob: empty response body'));
    focused.set({ id: 'photos:2026/trip/a.dng', filename: 'a.dng' } as Asset);
    await settle(REFINE_MS + 50);

    const overlay = fixture.nativeElement.querySelector('[data-testid="byte-load-error"]');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('Network error');
  });

  it('Retry re-attempts bytesForAsset and clears the error on success', async () => {
    bytesForAssetSpy
      .mockRejectedValueOnce({ status: 503, url: '/api/image/photos/trip/a.dng' })
      .mockResolvedValueOnce(new Uint8Array([0x44, 0x4e, 0x47]));
    focused.set({ id: 'photos:2026/trip/a.dng', filename: 'a.dng' } as Asset);
    await settle(REFINE_MS + 50);

    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="byte-load-error"] button',
    );
    expect(button).toBeTruthy();
    button.click();
    await settle(REFINE_MS + 50);

    expect(bytesForAssetSpy).toHaveBeenCalledTimes(2);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('[data-testid="byte-load-error"]')).toBeFalsy();
  });
});
