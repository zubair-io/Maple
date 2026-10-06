// #2407: a byte-fetch failure must not leave a silent blank canvas. Verifies
// the overlay names the file and offers a Retry action, and that Retry
// re-attempts the fetch (clearing the error state on success).

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { LibraryStateService } from '../../state/library-state.service';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { EmbeddedPreviewService } from '../../raw-pipeline/embedded-preview.service';
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
  let model: WritableSignal<ReturnType<typeof defaultAdjustmentModel>>;
  let capabilities: LensCorrectionCapabilities;
  let previewSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    decodeSpy = vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
      Promise.resolve(decodedAt(mle)),
    );
    bytesForAssetSpy = vi.fn();
    model = signal(defaultAdjustmentModel());
    previewSpy = vi.fn().mockRejectedValue(new Error('embedded preview unavailable'));

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

    capabilities = new LensCorrectionCapabilities();
    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: () => model,
      // No in-memory bytes — force the async backend-fetch path.
      bytesFor: () => undefined,
      bytesForAsset: bytesForAssetSpy,
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
        { provide: EmbeddedPreviewService, useValue: { extractEmbeddedPreview: previewSpy } },
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          useValue: {
            decode: decodeSpy,
            closeNativeDetail: vi.fn(),
            deepDenoiseProgress: signal(null),
            scopeSample: signal(null),
          },
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

  async function changeProfile(profile: 'Auto' | 'Neutral'): Promise<void> {
    capabilities.resetAutoFit(focused()!.id);
    model.set({ ...model(), profile });
    await settle();
  }

  for (const terminal of ['no source', 'fetch failed', 'normalization failed'])
    it(`settles Auto after Neutral following terminal ${terminal}`, async () => {
      const source = new Uint8Array([4, 5, 6]);
      if (terminal === 'normalization failed') bytesForAssetSpy.mockResolvedValueOnce(source);
      else bytesForAssetSpy.mockRejectedValueOnce({ status: 404 });
      const id = terminal === 'no source' ? 'imported-without-source' : 'photos:failed';
      focused.set({
        id,
        filename: terminal === 'normalization failed' ? 'photo.x3f' : 'photo.dng',
      } as Asset);
      await settle();
      expect(capabilities.for(id).autoFit).toBe(false);
      if (terminal === 'normalization failed')
        expect(previewSpy).toHaveBeenCalledWith(source, 'x3f');
      await changeProfile('Neutral');
      await changeProfile('Auto');
      expect(capabilities.for(id).autoFit).toBe(false);
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(source).toEqual(new Uint8Array([4, 5, 6]));
    });

  it('keeps a genuine pending byte request pending across profile changes', async () => {
    bytesForAssetSpy.mockReturnValue(new Promise(() => undefined));
    focused.set({ id: 'photos:pending', filename: 'photo.dng' } as Asset);
    await settle();
    await changeProfile('Neutral');
    await changeProfile('Auto');
    expect(capabilities.for('photos:pending').autoFit).toBeUndefined();
    expect(bytesForAssetSpy).toHaveBeenCalledOnce();
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('clears terminal provenance when an explicit retry starts a new request', async () => {
    bytesForAssetSpy
      .mockRejectedValueOnce({ status: 404 })
      .mockReturnValueOnce(new Promise(() => undefined));
    focused.set({ id: 'photos:retry', filename: 'photo.dng' } as Asset);
    await settle();
    expect(capabilities.for('photos:retry').autoFit).toBe(false);
    fixture.componentInstance.retryByteLoad();
    await settle();
    expect(capabilities.for('photos:retry').autoFit).toBeUndefined();
    expect(fixture.componentInstance.byteLoadError()).toBeNull();
    expect(bytesForAssetSpy).toHaveBeenCalledTimes(2);
  });

  for (const newer of [
    'accepted bytes',
    'completed active',
    'completed unavailable',
    'different asset',
  ])
    it(`does not replay terminal failure over ${newer}`, async () => {
      const id = 'photos:failed';
      bytesForAssetSpy.mockRejectedValueOnce({ status: 404 });
      focused.set({ id, filename: 'photo.dng' } as Asset);
      await settle();
      await changeProfile('Neutral');
      capabilities.resetAutoFit(id);
      model.set({ ...model(), profile: 'Auto' });
      const component = fixture.componentInstance;
      if (newer === 'accepted bytes') component.currentBytes = new Uint8Array([7, 8, 9]);
      if (newer === 'different asset') component.currentAssetId = 'photos:new';
      if (newer.startsWith('completed'))
        capabilities.seedProfile(
          id,
          null,
          newer === 'completed active',
          capabilities.autoFitRevisionFor(id),
        );
      await settle();
      expect(capabilities.for(id).autoFit).toBe(
        newer === 'completed active' ? true : newer === 'completed unavailable' ? false : undefined,
      );
      expect(decodeSpy).not.toHaveBeenCalled();
    });

  it('ignores a Retry for an error belonging to the previous asset', async () => {
    bytesForAssetSpy.mockRejectedValueOnce({ status: 404 });
    focused.set({ id: 'photos:failed', filename: 'photo.dng' } as Asset);
    await settle();
    fixture.componentInstance.currentAssetId = 'photos:new';
    const revision = capabilities.autoFitRevisionFor('photos:failed');
    fixture.componentInstance.retryByteLoad();
    expect(capabilities.autoFitRevisionFor('photos:failed')).toBe(revision);
    expect(bytesForAssetSpy).toHaveBeenCalledOnce();
  });

  for (const failure of ['decode', 'bitmap'])
    it(`renders new Auto intent after an actual cold CPU ${failure} failure`, async () => {
      bytesForAssetSpy.mockResolvedValue(new Uint8Array([4, 5, 6]));
      if (failure === 'decode') decodeSpy.mockRejectedValueOnce(new Error('cold decode failed'));
      else vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('cold bitmap failed'));
      decodeSpy.mockImplementation(() => Promise.resolve({ ...decodedAt(512), autoFit: true }));
      focused.set({ id: 'photos:cold-failed', filename: 'photo.dng' } as Asset);
      await settle();
      expect(capabilities.for('photos:cold-failed').autoFit).toBe(false);
      expect(fixture.componentInstance.currentBytes).not.toBeNull();
      expect(fixture.componentInstance.coldOpenDone).toBe(false);
      await changeProfile('Neutral');
      await changeProfile('Auto');
      expect(capabilities.for('photos:cold-failed').autoFit).toBe(false);
      expect(decodeSpy).toHaveBeenCalledOnce();
      fixture.componentInstance.retryByteLoad();
      await settle();
      expect(capabilities.for('photos:cold-failed').autoFit).toBe(true);
      expect(fixture.componentInstance.coldOpenDone).toBe(true);
      expect(fixture.componentInstance.imageBitmap()).not.toBeNull();
      expect(bytesForAssetSpy).toHaveBeenCalledTimes(2);
    });

  it('presents the current profile after successful held cold decode and queued profile changes', async () => {
    let finish!: (reply: DecodedImage) => void;
    const held = new Promise<DecodedImage>((done) => {
      finish = done;
    });
    const source = new Uint8Array([4, 5, 6]);
    bytesForAssetSpy.mockResolvedValue(source);
    decodeSpy
      .mockImplementationOnce(() => held)
      .mockImplementation((_b, _e, xmp, max) =>
        Promise.resolve({ ...decodedAt(max), autoFit: !xmp?.includes('Neutral') }),
      );
    vi.spyOn(fixture.componentInstance.state, 'updateAssetDimensions').mockImplementation(() =>
      focused.update((asset) => (asset ? { ...asset } : null)),
    );
    focused.set({ id: 'photos:held', filename: 'photo.dng' } as Asset);
    await settle();
    expect(decodeSpy).toHaveBeenCalledOnce();
    await changeProfile('Neutral');
    finish({ ...decodedAt(512), autoFit: true });
    await settle(REFINE_MS + 50);
    expect(decodeSpy.mock.calls.some((call) => call[2]?.includes('Neutral'))).toBe(true);
    expect(fixture.componentInstance.canvasSvc.currentPixels()?.autoFit).toBe(false);
    expect(capabilities.for('photos:held').autoFit).toBe(false);
    await changeProfile('Auto');
    await settle(REFINE_MS + 50);
    expect(fixture.componentInstance.canvasSvc.currentPixels()?.autoFit).toBe(true);
    expect(capabilities.for('photos:held').autoFit).toBe(true);
    expect(source).toEqual(new Uint8Array([4, 5, 6]));
    expect(bytesForAssetSpy).toHaveBeenCalledOnce();
  });

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
