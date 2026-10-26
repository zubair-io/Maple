import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoFitOutcomeFrom } from './auto-fit-outcome';
import { RawPipelineService } from './raw-pipeline.service';
import { WorkerStub, installWorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodeRequest, DecodeSuccess } from './raw-pipeline.types';

describe('autoFitOutcomeFrom', () => {
  it('maps every WASM outcome and treats unknown values as an unfitted Auto run', () => {
    expect(autoFitOutcomeFrom('applied')).toBe('applied');
    expect(autoFitOutcomeFrom('no-preview')).toBe('no-preview');
    expect(autoFitOutcomeFrom('unfitted')).toBe('unfitted');
    expect(autoFitOutcomeFrom('future-reason')).toBe('unfitted');
    expect(autoFitOutcomeFrom(undefined)).toBeUndefined();
    expect(autoFitOutcomeFrom(null)).toBeUndefined();
  });
});

describe('RawPipelineService Auto outcome round trip', () => {
  let workerStub: WorkerStub;
  let restoreWorker: () => void;

  beforeEach(() => {
    workerStub = new WorkerStub();
    restoreWorker = installWorkerStub(workerStub).restore;
    TestBed.configureTestingModule({});
  });

  afterEach(() => restoreWorker());

  it('delivers a missing camera preview from the worker reply to the decoded image', async () => {
    const service = TestBed.inject(RawPipelineService);
    const decoded = service.decode(new Uint8Array([0x44]), 'dng');
    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    workerStub.reply({
      id: sent.id,
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
      autoFit: 'no-preview',
    } satisfies DecodeSuccess);
    expect((await decoded).autoFit).toBe('no-preview');
  });
});
