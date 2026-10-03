import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCanvasComparison } from './image-canvas.comparison';
import type { ImageCanvasComponent } from './image-canvas.component';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import type { LibraryStore } from '../../state/library-store.service';
import type { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import type { WorkflowVariantSelectionService } from '../../xmp/workflow-variant-selection.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(gpu = false) {
  const focused = signal({ id: 'a', filename: 'a.dng' });
  const model = signal({ ...defaultAdjustmentModel(), exposure: 1 });
  const split = signal<number | null>(null);
  const active = signal(gpu);
  const color = signal('display-p3');
  const width = signal(1200);
  const variant = signal('primary');
  const bytes = new Uint8Array([1, 2, 3]);
  const decode = vi.fn(async (..._args: unknown[]) => ({
    width: 1,
    height: 1,
    rgb: new Uint8Array([40, 50, 60]),
  }));
  const exportImage = vi.fn(async (..._args: unknown[]) => ({ blob: new Blob(['baseline']) }));
  const getLattice = vi.fn(async (_id: string) => new ArrayBuffer(8));
  const host = {
    state: { focusedAsset: focused, adjustmentFor: () => model },
    canvasSvc: { beforeAfterSplitX: split },
    gpuPresent: { active, colorSpace: color },
    imageBitmap: signal({} as ImageBitmap),
    coldOpenDone: true,
    currentBytes: bytes,
    currentExt: 'dng',
    fastTargetPx: () => width(),
    serializeForRender: (value: ReturnType<typeof defaultAdjustmentModel>) =>
      TestBed.inject(XmpSerializerService).serialize(value),
    pipeline: { decode, exportImage },
    filmLut: { getLattice },
  } as unknown as ImageCanvasComponent;
  const comparison = new ImageCanvasComparison(
    host,
    {
      backend: 'hosted',
      hydrateAdjustment: (_id: string, value: unknown) => value,
    } as unknown as LibraryStore,
    {} as XmpAdjustmentRestoreService,
    {
      current: () => ({ scope: 'folder', variantId: variant() }),
    } as unknown as WorkflowVariantSelectionService,
  );
  const cleanup = comparison.wire(TestBed.inject(Injector));
  return {
    comparison,
    cleanup,
    model,
    focused,
    split,
    color,
    width,
    variant,
    decode,
    exportImage,
    getLattice,
    bytes,
  };
}
async function settle(milliseconds = 0) {
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(milliseconds);
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);
}
let cleanup: (() => void) | undefined;
let bitmap: ImageBitmap;
beforeEach(() => {
  TestBed.configureTestingModule({ providers: [XmpSerializerService] });
  vi.useFakeTimers();
  bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: unknown,
        public width: number,
        public height: number,
      ) {}
    },
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('session-open comparison ownership (#4073)', () => {
  it('captures before edits and reuses the baseline through slider ticks and peek toggles', async () => {
    const s = setup();
    cleanup = s.cleanup;
    await settle();
    s.model.update((value) => ({ ...value, exposure: 2 }));
    s.split.set(0.5);
    await settle(150);
    expect(s.decode).toHaveBeenCalledTimes(1);
    expect(s.decode.mock.calls[0]?.[2]).toContain('crs:Exposure2012="1"');
    for (const exposure of [3, 4, 5]) {
      s.model.update((value) => ({ ...value, exposure }));
      await settle(200);
    }
    s.split.set(1);
    await settle(200);
    s.split.set(null);
    await settle();
    s.split.set(0.3);
    await settle(200);
    expect(s.decode).toHaveBeenCalledTimes(1);
    expect(s.model().exposure).toBe(5);
    expect(Array.from(s.bytes)).toEqual([1, 2, 3]);
  });
  it('uses a lossless P3 reference for P3 GPU presentation without changing the live model', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    await settle();
    s.model.update((value) => ({ ...value, exposure: 4 }));
    s.split.set(1);
    await settle(150);
    expect(s.decode).not.toHaveBeenCalled();
    expect(s.exportImage).toHaveBeenCalledWith(
      s.bytes,
      'dng',
      { format: 'png', quality: 100, colorSpace: 'display-p3', maxSidePixels: 1200 },
      expect.stringContaining('crs:Exposure2012="1"'),
      undefined,
    );
    expect(s.comparison.bitmap()).toBe(bitmap);
    expect(s.model().exposure).toBe(4);
  });
  it('follows the achieved sRGB GPU tag rather than assuming P3', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    s.color.set('srgb');
    await settle();
    s.split.set(0.5);
    await settle(150);
    expect(s.decode).toHaveBeenCalledTimes(1);
    expect(s.exportImage).not.toHaveBeenCalled();
  });
  it('reports an unknown GPU colour space instead of showing a misleading baseline', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    s.color.set('unknown');
    await settle();
    s.split.set(0.5);
    await settle(150);
    expect(s.comparison.error()).toBe('Original preview unavailable');
    expect(s.comparison.bitmap()).toBeNull();
    expect(s.exportImage).not.toHaveBeenCalled();
  });
  it('keeps the opening film look when the current look changes', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    s.model.update((value) => ({ ...value, filmLook: 'original-look' }));
    await settle();
    s.model.update((value) => ({ ...value, filmLook: 'new-look' }));
    s.split.set(0.5);
    await settle(150);
    expect(s.getLattice).toHaveBeenCalledWith('original-look');
    expect(s.getLattice).not.toHaveBeenCalledWith('new-look');
  });
  it('debounces crop registration and bounds the owned resolution', async () => {
    const s = setup();
    cleanup = s.cleanup;
    await settle();
    s.split.set(0.5);
    await settle(150);
    s.width.set(10000);
    for (const angle of [1, 2, 3]) {
      s.model.update((value) => ({ ...value, crop: { ...value.crop, angle } }));
      await settle(20);
    }
    await settle(150);
    expect(s.decode).toHaveBeenCalledTimes(2);
    expect(s.decode.mock.calls[1]?.[3]).toBe(4096);
    expect(s.decode.mock.calls[1]?.[2]).toContain('crs:CropAngle="3.000000"');
  });
  it('refuses an obsolete variant reply', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    const first = deferred<{ blob: Blob }>();
    s.exportImage.mockImplementationOnce(() => first.promise);
    await settle();
    s.split.set(0.5);
    await settle(150);
    s.variant.set('second');
    s.model.update((value) => ({ ...value, exposure: 2 }));
    await settle(150);
    expect(s.exportImage).toHaveBeenCalledTimes(2);
    const confirmed = s.comparison.bitmap();
    first.resolve({ blob: new Blob(['old']) });
    await settle();
    expect(s.comparison.bitmap()).toBe(confirmed);
    expect(s.exportImage.mock.calls[1]?.[3]).toContain('crs:Exposure2012="2"');
  });
  it('closes a bitmap that completes after switching assets', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    const pending = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockImplementationOnce(() => pending.promise);
    await settle();
    s.split.set(0.5);
    await settle(150);
    s.focused.set({ id: 'b', filename: 'b.dng' });
    await settle();
    const obsolete = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    pending.resolve(obsolete);
    await settle();
    expect(obsolete.close).toHaveBeenCalledTimes(1);
    expect(s.comparison.bitmap()).not.toBe(obsolete);
  });
  it('shows failures and requires retry instead of repeating work on every edit', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    s.exportImage.mockRejectedValueOnce(new Error('transport'));
    await settle();
    s.split.set(0.5);
    await settle(150);
    expect(s.comparison.error()).toBe('Original preview unavailable');
    s.model.update((value) => ({ ...value, exposure: 9 }));
    await settle(200);
    expect(s.exportImage).toHaveBeenCalledTimes(1);
    s.comparison.retry();
    await settle(150);
    expect(s.exportImage).toHaveBeenCalledTimes(2);
    expect(s.comparison.error()).toBeNull();
  });
  it('cancels an in-flight peek when comparison is released', async () => {
    const s = setup(true);
    cleanup = s.cleanup;
    const pending = deferred<{ blob: Blob }>();
    s.exportImage.mockImplementationOnce(() => pending.promise);
    await settle();
    s.split.set(1);
    await settle(150);
    s.split.set(null);
    await settle();
    pending.resolve({ blob: new Blob(['old']) });
    await settle();
    expect(s.comparison.bitmap()).toBeNull();
    expect(s.comparison.loading()).toBe(false);
  });
});
