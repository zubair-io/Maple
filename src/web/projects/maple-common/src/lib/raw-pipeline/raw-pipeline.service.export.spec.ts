import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RawPipelineService } from './raw-pipeline.service';
import { WorkerStub, installWorkerStub } from './raw-pipeline.service.test-helpers';
import type { ExportRequest } from './raw-pipeline.types';

describe('export worker recovery', () => {
  let worker: WorkerStub;
  let restore: () => void;
  const options = { format: 'jpeg' as const, quality: 92, colorSpace: 'srgb' as const };
  beforeEach(() => {
    worker = new WorkerStub();
    restore = installWorkerStub(worker).restore;
    TestBed.configureTestingModule({});
  });
  afterEach(() => restore());

  it('releases the retained detail mosaic before posting a full-image export', async () => {
    const service = TestBed.inject(RawPipelineService);
    const tile = service.renderNativeDetail({
      sourceId: 'photo',
      bytes: new Uint8Array([1]),
      ext: 'dng',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      maxLongEdge: 1,
      qualityPreview: true,
    });
    await Promise.resolve();
    const tileRequest = worker.postMessage.mock.calls[0][0] as { id: number };
    worker.reply({
      id: tileRequest.id,
      type: 'native-detail-success',
      width: 1,
      height: 1,
      rgb: new ArrayBuffer(3),
    });
    await tile;
    const exportPromise = service.exportImage(new Uint8Array([1]), 'dng', options);
    await Promise.resolve();
    const requests = worker.postMessage.mock.calls.map(([request]) => request as ExportRequest);
    expect(requests.map((request) => request.type)).toEqual([
      'native-detail',
      'close-native-detail',
      'export',
    ]);
    worker.reply({ id: requests[2].id, type: 'export-error', message: 'Test complete' });
    await expect(exportPromise).rejects.toThrow('Test complete');
  });

  it('terminates a poisoned WASM worker and renders the next photo in a fresh worker', async () => {
    const service = TestBed.inject(RawPipelineService);
    const failed = service.exportImage(new Uint8Array([1]), 'dng', options);
    await Promise.resolve();
    const request = worker.postMessage.mock.calls[0][0] as ExportRequest;
    worker.reply({
      id: request.id,
      type: 'export-error',
      fatal: true,
      message: 'Renderer stopped',
    });
    await expect(failed).rejects.toThrow('Renderer stopped');
    expect(worker.terminate).toHaveBeenCalledOnce();

    const replacement = new WorkerStub();
    const undoReplacement = installWorkerStub(replacement).restore;
    try {
      const next = service.exportImage(new Uint8Array([2]), 'dng', options);
      await Promise.resolve();
      const nextRequest = replacement.postMessage.mock.calls[0][0] as ExportRequest;
      replacement.reply({
        id: nextRequest.id,
        type: 'export-success',
        width: 1,
        height: 1,
        extension: 'jpg',
        blob: new Blob(['encoded bytes']),
      });
      await expect(next).resolves.toMatchObject({ width: 1, height: 1 });
      expect(replacement.terminate).not.toHaveBeenCalled();
    } finally {
      undoReplacement();
    }
  });

  it('keeps the initialized worker for a normal preflight rejection', async () => {
    const service = TestBed.inject(RawPipelineService);
    const failed = service.exportImage(new Uint8Array([1]), 'dng', options);
    await Promise.resolve();
    const request = worker.postMessage.mock.calls[0][0] as ExportRequest;
    worker.reply({ id: request.id, type: 'export-error', message: 'Choose at most 4096 pixels' });
    await expect(failed).rejects.toThrow('4096 pixels');
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
