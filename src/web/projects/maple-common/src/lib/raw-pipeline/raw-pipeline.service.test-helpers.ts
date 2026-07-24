// raw-pipeline.service.test-helpers.ts
//
// Shared test-only support for the raw-pipeline.service.*.spec.ts files. Extracted
// out of raw-pipeline.service.spec.ts (file-budget split, #1123) so the WorkerStub
// has one definition instead of being duplicated per describe block / spec file.

import { vi } from 'vitest';

/**
 * Minimal Worker stub. Captures the most recently posted message and
 * exposes a `reply(...)` method the test calls to feed a response back
 * into the service's listener. Avoids spinning up a real Web Worker
 * (vitest's default jsdom environment doesn't bundle the WASM, and we
 * don't want specs to be flaky on raw-wasm rebuilds).
 */
export class WorkerStub {
  readonly postMessage = vi.fn<(msg: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();
  private listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    error: [],
  };

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }

  dispatchEvent(_e: Event): boolean {
    return true;
  }

  reply(payload: unknown): void {
    for (const fn of this.listeners['message'] ?? []) {
      fn({ data: payload } as unknown as MessageEvent);
    }
  }
}

/**
 * Install `workerStub` as the global `Worker` constructor for the duration of a
 * test (the service does `new Worker(...)`, so the global must be a real
 * constructor, not a `vi.fn()`). Returns a `restore()` to call in `afterEach`.
 */
export function installWorkerStub(workerStub: WorkerStub): { restore: () => void } {
  const originalWorker = globalThis.Worker;
  class WorkerCtor {
    constructor(_url: URL, _opts?: WorkerOptions) {
      return workerStub as unknown as Worker;
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    value: WorkerCtor,
    writable: true,
    configurable: true,
  });
  return {
    restore: () => {
      Object.defineProperty(globalThis, 'Worker', {
        value: originalWorker,
        writable: true,
        configurable: true,
      });
    },
  };
}
