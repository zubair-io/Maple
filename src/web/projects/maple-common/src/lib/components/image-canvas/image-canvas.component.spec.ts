// ImageCanvasComponent — live-canvas re-render on adjustment change (#846).
//
// Covers the TS-layer wiring that threads the current AdjustmentModel's XMP
// into the WASM decode and re-renders on edits, debounced + cancellable:
//   - cold open issues exactly one decode (no spurious pre-seed/seed decode)
//   - a burst of edits coalesces to a single debounced decode (no storm)
//   - switching assets cancels a pending re-render (timer cleared)
//   - Profile Auto→Neutral and a slider move each trigger a re-render
//
// Zoneless project: effects run on `fixture.detectChanges()`; the debounce
// timer is driven with vitest fake timers. The WASM render itself is exercised
// by raw-core's fixture-gated tests; this spec stubs RawPipelineService.decode
// and asserts on the requests it receives.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasService } from './image-canvas.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

const REFINE_MS = 150;

function fakeAsset(id: AssetId): Asset {
  return { id, filename: `${id}.dng` } as Asset;
}

function decoded(): DecodedImage {
  return {
    width: 1,
    height: 1,
    rgb: new Uint8Array([0x80, 0x80, 0x80]),
    asShotTemperature: 5200,
    asShotTint: 0,
  };
}

describe('ImageCanvasComponent — live re-render on adjustment change (#846)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    models = new Map();
    decodeSpy = vi.fn(() => Promise.resolve(decoded()));

    // jsdom has neither; the component observes resize + (de)allocates bitmaps.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(() =>
      Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
    );

    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: (id: AssetId) => {
        if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
        return models.get(id)!;
      },
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    const canvasStub = {
      currentPixels: signal<DecodedImage | null>(null),
      zoom: signal<'fit' | number>('fit'),
      pan: signal({ x: 0, y: 0 }),
      beforeAfterSplitX: signal<number | null>(null),
      showBeforeAfter: signal(false),
      resetView: vi.fn(),
      toggleBeforeAfter: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setSplit: vi.fn(),
      applyPanDelta: vi.fn(),
    } as unknown as Partial<ImageCanvasService>;

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        { provide: ImageCanvasService, useValue: canvasStub },
        { provide: RawPipelineService, useValue: { decode: decodeSpy } },
      ],
    });
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges(); // renders the real template + runs ngAfterViewInit
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // Flush effects + pending microtasks (decode promise) + the debounce timer.
  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges(); // run effects (decode effect / rerender effect)
    await vi.advanceTimersByTimeAsync(ms); // fire debounce + drain microtasks
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  function setModel(id: AssetId, patch: Partial<AdjustmentModel>): void {
    const sig = models.get(id) ?? signal(defaultAdjustmentModel());
    models.set(id, sig);
    sig.set({ ...sig(), ...patch });
  }

  it('cold open issues exactly one decode and no spurious pre-seed/seed decode', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    // Cold open decodes with NO xmp (raw-core substitutes As-Shot WB).
    expect(decodeSpy.mock.calls[0][2]).toBeUndefined();
  });

  it('an edit after cold open re-renders with the serialized XMP', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(REFINE_MS + 10);

    expect(decodeSpy).toHaveBeenCalledTimes(2);
    const xmp = decodeSpy.mock.calls[1][2] as string;
    expect(typeof xmp).toBe('string');
    expect(xmp).toContain('crs:Exposure2012="1"');
  });

  it('a Profile Auto→Neutral toggle re-renders', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { profile: 'Neutral' });
    await settle(REFINE_MS + 10);

    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(decodeSpy.mock.calls[1][2] as string).toContain('papp:Profile="Neutral"');
  });

  it('coalesces a burst of edits into a single debounced decode (no storm)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // Simulate a slider drag: many model writes inside the debounce window.
    for (let i = 1; i <= 8; i += 1) {
      setModel('a', { exposure: i * 0.1 });
      await settle(20); // < REFINE_MS each → trailing debounce keeps resetting
    }
    // No decode yet beyond cold open — the trailing debounce hasn't elapsed.
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    await settle(REFINE_MS + 10);

    // Exactly one refine decode fires, carrying the LAST edit's XMP.
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(decodeSpy.mock.calls[1][2] as string).toContain('crs:Exposure2012="0.8"');
  });

  it('switching assets cancels a pending re-render', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(20); // edit scheduled but debounce not yet elapsed

    // Switch to a new asset before the refine timer fires.
    focused.set(fakeAsset('b'));
    await settle(REFINE_MS + 50); // b's cold-open decode; a's timer was cleared

    // a's pending edit decode must have been cancelled; only the two cold
    // opens (a + b), both no-XMP, should have run.
    const xmps = decodeSpy.mock.calls.map((c) => c[2]);
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(xmps.every((x) => x === undefined)).toBe(true);
  });
});
