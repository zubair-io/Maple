// #5923: the imported Auto WB estimate is a synchronous wasm call on the render
// worker. A slider render posted while the estimate waits on the worker's queue
// cancels it through the shared flag; the estimate starts again once the editor
// is idle and lands the same pair. Runs the production service, worker handlers
// and wasm bundle in process. The latency the tick gains is measured in real
// Chrome by e2e/imported-auto-wb-cancel.
import { TestBed } from '@angular/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CpuLiveSession, imported_wb_cancel_flag } from './pkg/raw_wasm';
import { RawPipelineService } from './raw-pipeline.service';
import type { DecodedImage } from './raw-pipeline.types';
import {
  fixtureRaw,
  installInProcessRawWorker,
  type InProcessRawWorker,
} from './raw-pipeline.in-process-worker.test-helpers';

const nameOnly =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>';

function uninterrupted(bytes: Uint8Array): number[] {
  const session = CpuLiveSession.open(bytes, 'dng');
  try {
    return [...session.resolve_imported_white_balance()!];
  } finally {
    session.free();
  }
}

describe('a render posted during the imported Auto WB estimate (#5923)', () => {
  let worker: InProcessRawWorker;
  beforeAll(async () => {
    worker = await installInProcessRawWorker();
  });
  afterAll(() => worker.restore());

  it('cancels the estimate, which lands the same pair once idle', async () => {
    TestBed.configureTestingModule({});
    const pipeline = TestBed.inject(RawPipelineService);
    const bytes = fixtureRaw('source');
    const reference = uninterrupted(bytes);
    await pipeline.decode(bytes, 'dng', nameOnly, 640, true);
    worker.emit({
      id: 0,
      type: 'status',
      threaded: false,
      threads: 1,
      importedWbCancel: imported_wb_cancel_flag(),
    });

    let tick: Promise<DecodedImage> | null = null;
    worker.onPost = (request) => {
      if (request.type !== 'resolve-imported-wb' || tick) return;
      tick = pipeline.decode(bytes, 'dng', nameOnly, 640, true);
    };
    const pair = pipeline.resolveImportedWhiteBalance(bytes);
    await expect.poll(() => tick, { timeout: 5_000 }).not.toBeNull();
    await tick;
    worker.onPost = null;

    const settled = await pair;
    expect([settled.temperature, settled.tint]).toEqual(reference);
    const asked = worker.requests.filter((request) => request.type === 'resolve-imported-wb');
    expect(asked).toHaveLength(2);
  });
});
