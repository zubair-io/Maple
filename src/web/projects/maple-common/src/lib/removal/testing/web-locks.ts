import * as workerThreads from 'node:worker_threads';

type LockCallback = (lock: Lock | null) => unknown;

/** Install a real or serializing Web Locks manager for filesystem integration tests.
 * Node exposes a native LockManager; Bun's worker_threads currently does not.
 */
export function installTestWebLocks(): void {
  const locks = Reflect.get(workerThreads, 'locks') ?? createSerialTestLockManager();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
}

export function createSerialTestLockManager(): LockManager {
  const tails = new Map<string, Promise<void>>();
  return {
    request(
      name: string,
      optionsOrCallback: LockOptions | LockCallback,
      callback?: LockCallback,
    ): Promise<unknown> {
      const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      if (!run) return Promise.reject(new TypeError('A lock callback is required.'));

      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(() => run({ name, mode: 'exclusive' } as Lock));
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(name, tail);
      return result.finally(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
    },
  } as LockManager;
}
