// ImageExportService round-trip (#943).
//
// Drives the real service against a stubbed worker + stubbed library/XMP
// collaborators, so the assertions cover the wiring the UI depends on: the
// current adjustments reach the renderer as XMP, the user's options reach the
// worker unaltered, the sidecar is refreshed, and the file is handed to the
// browser under the right name.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ImageExportService, extensionOf } from './image-export.service';
import { LibraryStateService } from '../state/library-state.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { GPU_LIVE_RENDER_ENABLED } from '../raw-pipeline/gpu-live-render.token';
import { WorkerStub, installWorkerStub } from '../raw-pipeline/raw-pipeline.service.test-helpers';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { Asset } from '../models/asset';
import type { RawExportOptions } from '../raw-pipeline/raw-pipeline.types';

const RAW_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SIDECAR_XML = '<x:xmpmeta>serialized</x:xmpmeta>';

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    filename: 'IMG_0042.CR3',
    folderId: 'folder-1',
    rating: 3,
    flag: 'none',
    colorLabel: 'none',
    thumbnailGradient: '',
    aspectRatio: 1.5,
    width: 6000,
    height: 4000,
    keywords: ['trip'],
    ...overrides,
  } as Asset;
}

const OPTIONS: RawExportOptions = {
  format: 'tiff',
  quality: 88,
  colorSpace: 'display-p3',
  maxSidePixels: 2048,
};

describe('ImageExportService', () => {
  let workerStub: WorkerStub;
  let restoreWorker: () => void;
  let service: ImageExportService;
  let scheduleSidecarWrite: ReturnType<typeof vi.fn>;
  let flushPendingXmpWrites: ReturnType<typeof vi.fn>;
  let serialize: ReturnType<typeof vi.fn>;
  let clickedAnchors: HTMLAnchorElement[];
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    // Reset FIRST, matching the house convention (see `sidecar.store.spec.ts`):
    // the Angular unit-test builder shares one TestBed across spec files, so a
    // spec that configures without resetting inherits — and then strands — the
    // previous file's instantiated module.
    TestBed.resetTestingModule();

    workerStub = new WorkerStub();
    restoreWorker = installWorkerStub(workerStub).restore;

    scheduleSidecarWrite = vi.fn();
    flushPendingXmpWrites = vi.fn().mockResolvedValue(undefined);
    serialize = vi.fn().mockReturnValue(SIDECAR_XML);

    const libraryStub = {
      bytesForAsset: vi.fn().mockResolvedValue(RAW_BYTES),
      adjustmentFor: vi.fn().mockReturnValue(signal(defaultAdjustmentModel())),
      scheduleSidecarWrite,
      flushPendingXmpWrites,
    };

    TestBed.configureTestingModule({
      providers: [
        ImageExportService,
        RawPipelineService,
        { provide: GPU_LIVE_RENDER_ENABLED, useValue: false },
        { provide: LibraryStateService, useValue: libraryStub },
        {
          provide: XmpStoreService,
          useValue: { passthroughFor: vi.fn().mockReturnValue(undefined) },
        },
        { provide: XmpSerializerService, useValue: { serialize } },
      ],
    });
    service = TestBed.inject(ImageExportService);

    // Capture the download without letting jsdom navigate.
    clickedAnchors = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue('blob:stub');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this);
    });
  });

  afterEach(() => {
    restoreWorker();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  /** Run an export and feed the worker's success reply back in. */
  async function runExport(
    asset: Asset,
    options: RawExportOptions,
    blob = new Blob(['encoded'], { type: 'image/tiff' }),
    extension = 'tif',
  ) {
    const pending = service.exportAsset(asset, options);
    // Let bytesForAsset + the decodeChain gate settle so the request is posted.
    await vi.waitFor(() => expect(workerStub.postMessage).toHaveBeenCalled());
    const posted = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({
      id: posted.id,
      type: 'export-success',
      width: 2048,
      height: 1365,
      extension,
      blob,
    });
    return { outcome: await pending, posted };
  }

  it('forwards the chosen options to the worker unaltered', async () => {
    await runExport(makeAsset(), OPTIONS);

    const posted = workerStub.postMessage.mock.calls[0][0] as {
      type: string;
      ext: string;
      xmp: string;
      options: RawExportOptions;
    };
    expect(posted.type).toBe('export');
    expect(posted.options).toEqual(OPTIONS);
    expect(posted.ext).toBe('cr3');
  });

  it('sends the serialized current adjustments as the XMP the render reads', async () => {
    await runExport(makeAsset(), OPTIONS);

    expect(serialize).toHaveBeenCalledTimes(1);
    const posted = workerStub.postMessage.mock.calls[0][0] as { xmp: string };
    expect(posted.xmp).toBe(SIDECAR_XML);
  });

  it('passes the asset culling fields through to the serializer', async () => {
    await runExport(makeAsset({ rating: 5, keywords: ['a', 'b'] }), OPTIONS);

    const culling = serialize.mock.calls[0][2];
    expect(culling).toMatchObject({ rating: 5, keywords: ['a', 'b'] });
  });

  it('refreshes the sidecar and flushes it rather than leaving it on the debounce', async () => {
    await runExport(makeAsset(), OPTIONS);

    expect(scheduleSidecarWrite).toHaveBeenCalledWith('asset-1');
    expect(flushPendingXmpWrites).toHaveBeenCalledTimes(1);
  });

  it('downloads the file named after the original with the export extension', async () => {
    const { outcome } = await runExport(makeAsset(), OPTIONS);

    expect(outcome.filename).toBe('IMG_0042.tif');
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].download).toBe('IMG_0042.tif');
  });

  it('reports the dimensions and size the worker returned', async () => {
    const blob = new Blob(['0123456789'], { type: 'image/tiff' });
    const { outcome } = await runExport(makeAsset(), OPTIONS, blob);

    expect(outcome.width).toBe(2048);
    expect(outcome.height).toBe(1365);
    expect(outcome.byteLength).toBe(blob.size);
  });

  it('still delivers the file when the sidecar write fails', async () => {
    flushPendingXmpWrites.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { outcome } = await runExport(makeAsset(), OPTIONS);

    expect(outcome.filename).toBe('IMG_0042.tif');
    expect(clickedAnchors).toHaveLength(1);
  });

  it('rejects when the worker reports an export error, and downloads nothing', async () => {
    const pending = service.exportAsset(makeAsset(), OPTIONS);
    await vi.waitFor(() => expect(workerStub.postMessage).toHaveBeenCalled());
    const posted = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: posted.id, type: 'export-error', message: 'decode failed' });

    await expect(pending).rejects.toThrow('decode failed');
    expect(clickedAnchors).toHaveLength(0);
  });
});

describe('extensionOf', () => {
  it('lowercases the extension', () => {
    expect(extensionOf('IMG_1.CR3')).toBe('cr3');
  });

  it('ignores a directory prefix', () => {
    expect(extensionOf('trip/IMG_1.DNG')).toBe('dng');
  });

  it('returns empty for a name with no extension', () => {
    expect(extensionOf('IMG_1')).toBe('');
  });

  it('does not treat a dotfile as an extension', () => {
    expect(extensionOf('.hidden')).toBe('');
  });
});
