// One name-only Auto WB resolve per worker session (#4669, #5882 review): a
// later ask on the same open photo joins the session's request, a failed
// estimate is not re-run on every edit, and a new session asks again. The
// estimate waits for an idle editor, and any other request cancels it through
// the worker's shared flag; it asks again at the next idle moment (#5923).
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RawPipelineService } from './raw-pipeline.service';
import { installWorkerStub, WorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodeRequest, DecodeSuccess } from './raw-pipeline.types';
import type { ResolveImportedWbRequest } from './raw-pipeline.imported-wb.types';
import { IMPORTED_WB_IDLE_MS } from './raw-pipeline.imported-wb-request';

describe('RawPipelineService.resolveImportedWhiteBalance', () => {
  let worker: WorkerStub;
  let sentAt: number[];
  let restore: () => void;
  beforeEach(() => {
    worker = new WorkerStub();
    sentAt = [];
    worker.postMessage.mockImplementation(() => void sentAt.push(performance.now()));
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

  /** How long the worker had been sent nothing when the `nth` `type` message went out. */
  const quietBefore = (type: string, nth: number): number => {
    const message = posted(type)[nth];
    const at = worker.postMessage.mock.calls.findIndex(([sent]) => sent === message);
    return sentAt[at] - sentAt[at - 1];
  };

  /** Open `bytes` as the retained CPU source, as the 2D canvas does; later
   *  calls render it again, as a slider tick does. */
  async function open(service: RawPipelineService, bytes: Uint8Array): Promise<void> {
    const before = posted<DecodeRequest>('decode').length;
    const decoded = service.decode(bytes, 'dng', undefined, 80, true);
    await expect.poll(() => posted<DecodeRequest>('decode').length).toBe(before + 1);
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
    await expect.poll(() => posted('resolve-imported-wb').length).toBe(1);
    const requests = posted<ResolveImportedWbRequest>('resolve-imported-wb');
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
    await expect.poll(() => posted('resolve-imported-wb').length).toBe(2);
    const next = posted<ResolveImportedWbRequest>('resolve-imported-wb');
    expect(next[1].session.token).not.toBe(requests[0].session.token);
    worker.reply({
      id: next[1].id,
      type: 'resolve-imported-wb-success',
      temperature: 4800,
      tint: 6,
    });
    await expect(pair).resolves.toEqual({ temperature: 4800, tint: 6 });
  });

  /** Hand the service the worker's cancel byte, as the worker's status does. */
  function shareCancelFlag(): Uint8Array {
    const flag = new Uint8Array(new SharedArrayBuffer(1));
    worker.reply({ id: 0, type: 'status', threaded: true, threads: 8, importedWbCancel: flag });
    return flag;
  }

  it('cancels a running estimate before any other request and asks again once idle', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    await open(service, bytes);
    const flag = shareCancelFlag();

    const pair = service.resolveImportedWhiteBalance(bytes);
    await expect.poll(() => posted('resolve-imported-wb').length).toBe(1);
    expect(quietBefore('resolve-imported-wb', 0)).toBeGreaterThanOrEqual(IMPORTED_WB_IDLE_MS - 1);
    expect(Atomics.load(flag, 0)).toBe(0);

    // A slider tick while the estimate runs: the flag is up before it is posted.
    await open(service, bytes);
    expect(Atomics.load(flag, 0)).toBe(1);
    const [cancelled] = posted<ResolveImportedWbRequest>('resolve-imported-wb');
    worker.reply({ id: cancelled.id, type: 'resolve-imported-wb-cancelled' });

    await expect
      .poll(() => posted('resolve-imported-wb').length, { timeout: 4 * IMPORTED_WB_IDLE_MS })
      .toBe(2);
    expect(quietBefore('resolve-imported-wb', 1)).toBeGreaterThanOrEqual(IMPORTED_WB_IDLE_MS - 1);
    expect(Atomics.load(flag, 0)).toBe(0);
    const retry = posted<ResolveImportedWbRequest>('resolve-imported-wb')[1];
    expect(retry.session).toEqual(cancelled.session);
    worker.reply({ id: retry.id, type: 'resolve-imported-wb-success', temperature: 5100, tint: 4 });
    await expect(pair).resolves.toEqual({ temperature: 5100, tint: 4 });

    // With no estimate running, requests leave the flag alone.
    await open(service, bytes);
    expect(Atomics.load(flag, 0)).toBe(0);
  });

  it('drops a cancelled estimate once another photo holds the worker', async () => {
    const service = TestBed.inject(RawPipelineService);
    const bytes = new Uint8Array([1, 2, 3]);
    await open(service, bytes);
    shareCancelFlag();
    const pair = service.resolveImportedWhiteBalance(bytes);
    await expect.poll(() => posted('resolve-imported-wb').length).toBe(1);
    await open(service, new Uint8Array([7, 8, 9]));
    const [cancelled] = posted<ResolveImportedWbRequest>('resolve-imported-wb');
    worker.reply({ id: cancelled.id, type: 'resolve-imported-wb-cancelled' });
    await expect(pair).rejects.toThrow('no longer open');
    expect(posted('resolve-imported-wb')).toHaveLength(1);
  });
});
