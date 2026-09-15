import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  callNative,
  MapleWorkerPoolOverloadedError,
  setMapleConcurrency,
  setMapleExecutionMode,
  shutdownMaplePool,
  _resetMaplePoolForTests,
} from '../src/worker-pool';
import { _resetNapiBindingForTests } from '../src/native-napi';
import type { WorkerRequest } from '../src/worker-protocol';

// Control scheduling at the Worker boundary: these tests exercise real pool
// admission and cleanup without a native decoder or timing-dependent sleeps.
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  static failStart = false;
  static failPost = false;
  request: WorkerRequest | null = null;
  terminated = false;

  constructor(_url: string) {
    super();
    if (ControlledWorker.failStart) throw new Error('worker startup failed');
    ControlledWorker.instances.push(this);
  }

  postMessage(request: WorkerRequest): void {
    if (ControlledWorker.failPost) throw new Error('request cannot be cloned');
    this.request = request;
  }

  ref(): void {}
  unref(): void {}
  terminate(): void {
    this.terminated = true;
    this.request = null;
    this.dispatchEvent(new Event('close'));
  }

  reply(): void {
    const id = this.request!.id;
    this.request = null;
    this.dispatchEvent(
      new MessageEvent('message', { data: { id, ok: true, result: { ok: true } } }),
    );
  }

  die(): void {
    this.dispatchEvent(new ErrorEvent('error', { message: 'worker died' }));
    this.dispatchEvent(new Event('close'));
  }
}

const originalWorker = globalThis.Worker;
const originalNapi = process.env.MAPLE_NAPI;
const filename = () => callNative('validateFilename', ['image.jpg']);
const outcome = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error);

beforeEach(() => {
  shutdownMaplePool();
  _resetMaplePoolForTests();
  ControlledWorker.instances = [];
  ControlledWorker.failStart = false;
  ControlledWorker.failPost = false;
  globalThis.Worker = ControlledWorker as unknown as typeof Worker;
  process.env.MAPLE_NAPI = '0';
  _resetNapiBindingForTests();
  setMapleExecutionMode('worker');
  setMapleConcurrency(1);
});

afterEach(() => {
  shutdownMaplePool();
  _resetMaplePoolForTests();
  globalThis.Worker = originalWorker;
  if (originalNapi === undefined) delete process.env.MAPLE_NAPI;
  else process.env.MAPLE_NAPI = originalNapi;
  _resetNapiBindingForTests();
});

describe('bounded Bun worker admission', () => {
  it('admits one active and one waiting call per worker, then drains in order', async () => {
    const active = filename();
    const waiting = filename();
    const rejected = await outcome(filename());
    expect(rejected).toBeInstanceOf(MapleWorkerPoolOverloadedError);
    expect((rejected as MapleWorkerPoolOverloadedError).code).toBe('MAPLE_WORKER_POOL_OVERLOADED');
    const worker = ControlledWorker.instances[0];
    expect(worker.request?.id).toBe(1);
    worker.reply();
    expect(await active).toEqual({ ok: true });
    expect(worker.request?.id).toBe(2);
    const recovered = filename();
    worker.reply();
    expect(await waiting).toEqual({ ok: true });
    worker.reply();
    expect(await recovered).toEqual({ ok: true });
    expect(ControlledWorker.instances).toHaveLength(1);
  });

  it('caps a 100-call burst at 16 active plus 16 waiting calls', async () => {
    setMapleConcurrency(100);
    const calls = Array.from({ length: 100 }, () => outcome(filename()));
    expect(ControlledWorker.instances).toHaveLength(16);
    for (const worker of ControlledWorker.instances) worker.reply();
    for (const worker of ControlledWorker.instances) worker.reply();
    const results = await Promise.all(calls);
    expect(
      results.filter((result) => result instanceof MapleWorkerPoolOverloadedError),
    ).toHaveLength(68);
    expect(results.filter((result) => !(result instanceof Error))).toHaveLength(32);
  });

  it('drains accepted calls when concurrency is lowered', async () => {
    setMapleConcurrency(2);
    const calls = Array.from({ length: 4 }, () => outcome(filename()));
    setMapleConcurrency(1);
    expect(await outcome(filename())).toBeInstanceOf(MapleWorkerPoolOverloadedError);
    for (const worker of ControlledWorker.instances) worker.reply();
    for (const worker of ControlledWorker.instances) worker.reply();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 4 }, () => ({ ok: true })));
  });

  it('replaces a dead worker, drains waiting work, and ignores its duplicate close', async () => {
    const active = outcome(filename());
    const waiting = filename();
    ControlledWorker.instances[0].die();
    expect(await active).toBeInstanceOf(Error);
    expect(ControlledWorker.instances).toHaveLength(2);
    ControlledWorker.instances[1].reply();
    expect(await waiting).toEqual({ ok: true });
    const recovered = filename();
    ControlledWorker.instances[1].reply();
    expect(await recovered).toEqual({ ok: true });
  });

  it('rejects waiting work when a replacement fails to start, then recovers', async () => {
    const active = outcome(filename());
    const waiting = outcome(filename());
    ControlledWorker.failStart = true;
    ControlledWorker.instances[0].die();
    expect(await active).toBeInstanceOf(Error);
    expect(((await waiting) as Error).message).toMatch(/startup failed/);
    expect(((await outcome(filename())) as Error).message).toMatch(/startup failed/);
    ControlledWorker.failStart = false;
    const recovered = filename();
    ControlledWorker.instances[1].reply();
    expect(await recovered).toEqual({ ok: true });
  });

  it('cleans up failed postMessage calls without consuming capacity', async () => {
    ControlledWorker.failPost = true;
    expect(((await outcome(filename())) as Error).message).toMatch(/cannot be cloned/);
    ControlledWorker.failPost = false;
    const recovered = filename();
    ControlledWorker.instances[1].reply();
    expect(await recovered).toEqual({ ok: true });
  });

  it('shutdown rejects active and queued calls and the next call starts a fresh pool', async () => {
    const calls = [outcome(filename()), outcome(filename())];
    shutdownMaplePool();
    for (const result of await Promise.all(calls)) {
      expect((result as Error).message).toMatch(/shut down/);
    }
    expect(ControlledWorker.instances[0].terminated).toBe(true);
    const recovered = filename();
    ControlledWorker.instances[1].reply();
    expect(await recovered).toEqual({ ok: true });
  });

  it.each(['shutdown', 'drain', 'replacement failure'] as const)(
    'retains only admitted buffers and releases them after %s',
    async (completion) => {
      const bytesPerInput = 4 * 1024 * 1024;
      const refs: WeakRef<Uint8Array>[] = [];
      const calls = Array.from({ length: 64 }, () => {
        const input = new Uint8Array(bytesPerInput);
        input.fill(1); // Commit the backing pages for the synthetic workload.
        refs.push(new WeakRef(input));
        return outcome(callNative('rasterProbeMetadataBuf', [input]));
      });
      const collect = async () => {
        // WeakRef targets stay alive through the current job; cross a turn
        // before forcing collection, including after inspecting the refs.
        await new Promise<void>((resolve) => setImmediate(resolve));
        Bun.gc(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        Bun.gc(true);
      };
      await collect();
      const retainedBytes = refs.filter((ref) => ref.deref() !== undefined).length * bytesPerInput;
      expect(retainedBytes).toBe(2 * bytesPerInput);
      if (completion === 'shutdown') {
        shutdownMaplePool();
      } else if (completion === 'drain') {
        ControlledWorker.instances[0].reply();
        ControlledWorker.instances[0].reply();
      } else {
        ControlledWorker.failStart = true;
        ControlledWorker.instances[0].die();
      }
      const results = await Promise.all(calls);
      expect(
        results.filter((result) => result instanceof MapleWorkerPoolOverloadedError),
      ).toHaveLength(62);
      await collect();
      const afterCompletionBytes =
        refs.filter((ref) => ref.deref() !== undefined).length * bytesPerInput;
      expect(afterCompletionBytes).toBe(0);
      console.info(
        `Worker admission: 256 MiB submitted, ${retainedBytes / 1024 / 1024} MiB retained, ${afterCompletionBytes} bytes after ${completion}`,
      );
    },
  );
});
