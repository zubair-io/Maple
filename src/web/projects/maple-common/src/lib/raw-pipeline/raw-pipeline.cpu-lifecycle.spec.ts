import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RawPipelineService } from './raw-pipeline.service';
import { installWorkerStub, WorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodeRequest, DecodeSuccess, DevelopNonRawRequest } from './raw-pipeline.types';

describe('CPU source serialized retirement', () => {
  let worker: WorkerStub;
  let restore: () => void;
  beforeEach(() => {
    worker = new WorkerStub();
    restore = installWorkerStub(worker).restore;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close() {} })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            drawImage() {},
            getImageData: () => ({ data: new Uint8ClampedArray([128, 128, 128, 255]) }),
          };
        }
      },
    );
    TestBed.configureTestingModule({});
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
  });
  const reply = (id: number): DecodeSuccess => ({
    id,
    type: 'decode-success',
    width: 1,
    height: 1,
    nativeWidth: 1,
    nativeHeight: 1,
    rgb: new Uint8Array(3).buffer,
    asShotTemperature: 5500,
    asShotTint: 0,
    hasLensCorrections: false,
    lensCorrectionCaInert: true,
  });

  it('RAW queued before non-RAW must reopen the same source after worker retirement', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    // Queue all calls before the first RAW's source registration runs.
    const first = service.decode(bytes, 'dng', undefined, 80, true);
    const raster = service.decode(new Uint8Array([4]), 'jpg');
    const next = service.decode(bytes, 'dng', undefined, 80, true);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
    const opened = worker.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(opened.bytes.byteLength).toBe(3);
    worker.reply(reply(opened.id));
    await first;
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    const nonRaw = worker.postMessage.mock.calls[1][0] as DevelopNonRawRequest;
    expect(nonRaw.type).toBe('develop-non-raw');
    worker.reply(reply(nonRaw.id));
    await raster;
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3));
    const reopened = worker.postMessage.mock.calls[2][0] as DecodeRequest;
    worker.reply(reply(reopened.id));
    await next;
    expect(reopened.bytes.byteLength).toBe(3);
    expect(reopened.cpuSourceToken).not.toBe(opened.cpuSourceToken);
  });
  it('GPU open overtakes queued RAW, which then decodes without retaining a source', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    const queued = service.decode(bytes, 'dng', undefined, 80, true);
    const gpu = service.openLiveSession({} as OffscreenCanvas, bytes, 'dng', undefined, 80);
    const gpuRequest = worker.postMessage.mock.calls[0][0] as { type: string; id: number };
    expect(gpuRequest.type).toBe('open-session');
    worker.reply({ ...reply(gpuRequest.id), type: 'open-session-success', colorSpace: 'srgb' });
    await gpu;
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    const stale = worker.postMessage.mock.calls[1][0] as DecodeRequest;
    expect(stale.type).toBe('decode');
    expect(stale.cpuSourceToken).toBeUndefined();
    expect(stale.bytes.byteLength).toBe(3);
    worker.reply(reply(stale.id));
    await queued;
    const fallback = service.decode(bytes, 'dng', undefined, 80, true);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3));
    const reopened = worker.postMessage.mock.calls[2][0] as DecodeRequest;
    worker.reply(reply(reopened.id));
    await fallback;
    expect(reopened.bytes.byteLength).toBe(3);
    expect(reopened.cpuSourceToken).toBe(reopened.id);
  });
  it('export after a retained render resends the source on the next tick', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    const first = service.decode(bytes, 'dng', undefined, 80, true);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
    const opened = worker.postMessage.mock.calls[0][0] as DecodeRequest;
    worker.reply(reply(opened.id));
    await first;
    void service.exportImage(bytes, 'dng', {} as never).catch(() => undefined);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    const exported = worker.postMessage.mock.calls[1][0] as { type: string; id: number };
    expect(exported.type).toBe('export');
    worker.reply({ id: exported.id, type: 'export-error', message: 'stop' } as never);
    const next = service.decode(bytes, 'dng', undefined, 80, true);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3));
    const reopened = worker.postMessage.mock.calls[2][0] as DecodeRequest;
    worker.reply(reply(reopened.id));
    await next;
    expect(reopened.bytes.byteLength).toBe(3);
    expect(reopened.cpuSourceToken).not.toBe(opened.cpuSourceToken);
  });
});
