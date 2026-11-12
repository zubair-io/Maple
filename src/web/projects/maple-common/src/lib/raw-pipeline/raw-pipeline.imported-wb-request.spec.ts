// One name-only Auto WB resolve per worker session (#4669, #5882 review): a
// later ask on the same open photo joins the session's request, a failed
// estimate is not re-run on every edit, and a new session asks again.
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RawPipelineService } from './raw-pipeline.service';
import { installWorkerStub, WorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodeRequest, DecodeSuccess } from './raw-pipeline.types';
import type { ResolveImportedWbRequest } from './raw-pipeline.imported-wb.types';

describe('RawPipelineService.resolveImportedWhiteBalance', () => {
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
          return { drawImage() {}, putImageData() {} };
        }
      },
    );
    TestBed.configureTestingModule({});
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
  });

  const posted = <T extends { type: string }>(type: string): T[] =>
    worker.postMessage.mock.calls
      .map(([message]) => message as T)
      .filter((message) => message.type === type);

  /** Open `bytes` as the retained CPU source, as the 2D canvas does. */
  async function open(service: RawPipelineService, bytes: Uint8Array): Promise<void> {
    const decoded = service.decode(bytes, 'dng', undefined, 80, true);
    await expect.poll(() => posted<DecodeRequest>('decode').length).toBeGreaterThan(0);
    const request = posted<DecodeRequest>('decode').at(-1)!;
    const reply: DecodeSuccess = {
      id: request.id,
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
    };
    worker.reply(reply);
    await decoded;
  }

  it('sends one request per session and lets later asks share its outcome', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    await open(service, bytes);

    const first = service.resolveImportedWhiteBalance(bytes);
    const later = service.resolveImportedWhiteBalance(bytes);
    const requests = posted<ResolveImportedWbRequest>('resolve-imported-wb');
    expect(requests).toHaveLength(1);
    worker.reply({ id: requests[0].id, type: 'session-error', message: 'estimate failed' });
    await expect(first).rejects.toThrow('estimate failed');
    await expect(later).rejects.toThrow('estimate failed');

    // An edit after the failure does not run the estimate again.
    await expect(service.resolveImportedWhiteBalance(bytes)).rejects.toThrow('estimate failed');
    expect(posted('resolve-imported-wb')).toHaveLength(1);

    // Another open is another session: it asks again.
    const reopened = new Uint8Array([4, 5, 6]);
    await open(service, reopened);
    const pair = service.resolveImportedWhiteBalance(reopened);
    const next = posted<ResolveImportedWbRequest>('resolve-imported-wb');
    expect(next).toHaveLength(2);
    expect(next[1].session.token).not.toBe(requests[0].session.token);
    worker.reply({
      id: next[1].id,
      type: 'resolve-imported-wb-success',
      temperature: 4800,
      tint: 6,
    });
    await expect(pair).resolves.toEqual({ temperature: 4800, tint: 6 });
  });
});
