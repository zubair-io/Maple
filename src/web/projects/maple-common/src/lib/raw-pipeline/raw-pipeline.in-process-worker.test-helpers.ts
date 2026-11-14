// raw-pipeline.in-process-worker.test-helpers.ts
//
// Test-only: runs the REAL render worker module (`raw-pipeline.worker.ts`) on the
// test thread over the REAL wasm bundle, so a spec drives `RawPipelineService`
// through the actual request → worker handler → wasm → reply round trip (#4669).
// The browser Worker boundary is replaced by an asynchronous in-memory channel;
// everything on both sides of it is production code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { initSync } from './pkg/raw_wasm';
import type { WorkerRequest, WorkerResponse } from './raw-pipeline.types';

type Listener = (event: { data: unknown }) => void;

/**
 * The worker module registers its listener once, at its first import. Specs
 * share one module graph (`isolate: false`), so a later install reuses it.
 */
let workerListener: Listener | null = null;

export interface InProcessRawWorker {
  /** Every request the service posted, in order. */
  readonly requests: WorkerRequest[];
  /** Runs synchronously as the service posts a request, before the worker sees it. */
  onPost: ((request: WorkerRequest) => void) | null;
  /** Deliver `message` to the service as if the worker had posted it. */
  emit(message: WorkerResponse): void;
  restore(): void;
}

/** Load the wasm and the worker module once, then route `new Worker(...)` to it. */
export async function installInProcessRawWorker(): Promise<InProcessRawWorker> {
  initSync({
    module: readFileSync(
      resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
    ),
  });
  const mainListeners: Listener[] = [];
  const requests: WorkerRequest[] = [];
  vi.stubGlobal('self', {
    location: globalThis.location,
    postMessage(message: WorkerResponse) {
      // Worker console forwarding would echo back into the console it wraps.
      if (message.type === 'worker-log') return;
      setTimeout(() => mainListeners.forEach((listener) => listener({ data: message })), 0);
    },
  });
  vi.stubGlobal('addEventListener', (type: string, listener: Listener) => {
    if (type === 'message') workerListener = listener;
  });
  const { log, warn, error } = globalThis.console;
  // Dynamic on purpose: the module's top-level side effects (listener, console
  // forwarding) must run after the stubs above, which a static import precedes.
  await import('./raw-pipeline.worker');
  Object.assign(globalThis.console, { log, warn, error });
  const registered = workerListener;
  if (!registered) throw new Error('raw-pipeline.worker did not register its listener');
  const deliver: Listener = registered;
  const harness: InProcessRawWorker = {
    requests,
    onPost: null,
    emit: (message) => mainListeners.forEach((listener) => listener({ data: message })),
    restore: () => vi.unstubAllGlobals(),
  };
  class InProcessWorker {
    addEventListener(type: string, listener: Listener): void {
      if (type === 'message') mainListeners.push(listener);
    }
    removeEventListener(): void {}
    terminate(): void {}
    postMessage(message: WorkerRequest): void {
      requests.push(message);
      harness.onPost?.(message);
      setTimeout(() => deliver({ data: message }), 0);
    }
  }
  vi.stubGlobal('Worker', InProcessWorker);
  return harness;
}

/** A committed fixture RAW (test-fixtures/batch-transfer). */
export function fixtureRaw(name: 'source' | 'target'): Uint8Array {
  return new Uint8Array(
    readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer', `${name}.dng`)),
  );
}
