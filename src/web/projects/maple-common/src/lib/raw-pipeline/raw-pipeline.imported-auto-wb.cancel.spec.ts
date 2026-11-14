// #5923: the imported Auto WB estimate is a synchronous wasm call on the render
// worker. A slider render posted while the estimate waits on the worker's queue
// cancels it through the shared flag and is served without waiting for it; the
// estimate starts again once the editor is idle and lands the same pair. Runs
// the production service, worker handlers and wasm bundle in process.
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

/** The uninterrupted estimate on an independent session, and how long it took. */
function uninterrupted(bytes: Uint8Array): { pair: number[]; ms: number } {
  const session = CpuLiveSession.open(bytes, 'dng');
  try {
    const started = performance.now();
    const pair = [...session.resolve_imported_white_balance()!];
    return { pair, ms: performance.now() - started };
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

  it('is served without the estimate, which lands the same pair once idle', async () => {
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
    let tickStarted = 0;
    worker.onPost = (request) => {
      if (request.type !== 'resolve-imported-wb' || tick) return;
      tickStarted = performance.now();
      tick = pipeline.decode(bytes, 'dng', nameOnly, 640, true);
    };
    const pair = pipeline.resolveImportedWhiteBalance(bytes);
    await expect.poll(() => tick, { timeout: 5_000 }).not.toBeNull();
    await tick;
    const tickMs = performance.now() - tickStarted;
    worker.onPost = null;
    console.info(
      `#5923 in-process: tick served in ${tickMs.toFixed(1)} ms; ` +
        `the uninterrupted estimate takes ${reference.ms.toFixed(1)} ms`,
    );
    expect(tickMs).toBeLessThan(reference.ms);

    const settled = await pair;
    expect([settled.temperature, settled.tint]).toEqual(reference.pair);
    const asked = worker.requests.filter((request) => request.type === 'resolve-imported-wb');
    expect(asked).toHaveLength(2);
  });
});
