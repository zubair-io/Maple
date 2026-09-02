// ImageCanvasComponent — GPU operator kill switch tears down an open live
// session (#2340).
//
// `GpuLiveRenderGate.enabled` is read per render request, so a flip lands on
// the next decode / session open on its own — but before this fix, an
// ALREADY-OPEN session kept presenting through the resident `WebLiveSession`
// until the asset changed or the page reloaded. That defeats the one case the
// switch exists for: getting off a wedged or corrupting GPU path without
// waiting on the user to act. `wireGpuKillSwitchEffect`
// (`image-canvas.gpu-present.ts`) reacts to the gate going false while a
// session is active by tearing it down and reopening the SAME asset through
// the 2D `decode()` path.
//
// Same TestBed/pipeline-stub setup as the "GPU live-render path (#1038)"
// suite in `image-canvas.component.spec.ts`, split into its own file to stay
// under the file-size budget — the one addition is `gpuLiveRenderEnabled`
// backed by a real signal (`gpuEnabled`) instead of a constant, so a test can
// flip it and let the effect react.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import { patchSecureGpuContext, type SecureGpuContextPatch } from './gpu-context-test-helpers';

const REFINE_MS = 150;
const NATIVE_W = 4000;
const NATIVE_H = 2500;

function fakeAsset(id: AssetId): Asset {
  return { id, filename: `${id}.dng` } as Asset;
}

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

describe('ImageCanvasComponent — GPU kill switch tears down an open session (#2340)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let gpuEnabled: WritableSignal<boolean>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let openSessionSpy: ReturnType<typeof vi.fn>;
  let closeSessionSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;
  let gpuContext: SecureGpuContextPatch;

  beforeEach(() => {
    vi.useFakeTimers();
    gpuContext = patchSecureGpuContext();
    focused = signal<Asset | null>(null);
    models = new Map();
    gpuEnabled = signal(true);
    decodeSpy = vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
      Promise.resolve(decodedAt(mle)),
    );
    openSessionSpy = vi.fn(() =>
      Promise.resolve({
        width: 4000,
        height: 3000,
        asShotTemperature: 5200,
        asShotTint: 0,
        colorSpace: 'display-p3',
      }),
    );
    closeSessionSpy = vi.fn();

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {};
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
    const transferSpy = vi.fn(() => ({}) as OffscreenCanvas);
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(
      (tag: string, opts?: ElementCreationOptions) => {
        const el = origCreate(tag, opts) as HTMLElement;
        if (tag === 'canvas') {
          (el as unknown as { transferControlToOffscreen: unknown }).transferControlToOffscreen =
            transferSpy;
        }
        return el;
      },
    );

    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: (id: AssetId) => {
        if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
        return models.get(id)!;
      },
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      seedLensCorrections: vi.fn(),
      lensCorrectionsFor: vi.fn(() => ({ hasLensCorrections: true, lensCorrectionCaInert: false })),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    const pipelineStub = {
      decode: decodeSpy,
      deepDenoiseProgress: signal(null),
      // Signal-backed (unlike the sibling GPU suite's constant `true`) so a
      // test can flip it mid-session and the kill-switch effect reacts.
      get gpuLiveRenderEnabled() {
        return gpuEnabled();
      },
      openLiveSession: openSessionSpy,
      renderLiveSession: vi.fn(() => Promise.resolve({ colorSpace: 'display-p3' })),
      closeLiveSession: closeSessionSpy,
    };

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        { provide: RawPipelineService, useValue: pipelineStub },
      ],
    });
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
    gpuContext.restore();
  });

  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('flipping the gate off while a session is open closes it and reopens through decode()', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).not.toHaveBeenCalled(); // still on the GPU path

    gpuEnabled.set(false);
    await settle(0);

    expect(closeSessionSpy).toHaveBeenCalledTimes(1);
    // Reopened the SAME asset through the 2D path, not a second GPU attempt.
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(openSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('flipping the gate off with no session open is a no-op', async () => {
    // Never focused an asset — nothing ever opened a GPU session.
    gpuEnabled.set(false);
    await settle(0);

    expect(closeSessionSpy).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('the gate flipping back on after a kill-switch reopen does not reopen a GPU session on its own', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    gpuEnabled.set(false);
    await settle(0);
    expect(closeSessionSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // Ramping back on doesn't retroactively reopen the session the operator
    // just killed — the gate is read on the NEXT open (asset switch / reload),
    // per the documented precedence in GpuLiveRenderGate.
    gpuEnabled.set(true);
    await settle(0);

    expect(openSessionSpy).toHaveBeenCalledTimes(1); // unchanged
  });
});
