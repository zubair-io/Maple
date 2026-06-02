/**
 * FFI decode pool's child-process factory.
 *
 * The generic child-process transport (`ChildProcessWorker`) now lives in
 * `runtime/child-process-worker.ts`, shared with the onnx face pool. This file
 * just names the FFI decode child entry and the priority it runs at, and
 * exposes the factory the pool injects (`ffi-pool.ts` is unchanged).
 */

import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from '../runtime/child-process-worker.ts';
import type { PoolWorker, WorkerFactory } from './ffi-pool.ts';

const FFI_CHILD_SCRIPT = childScriptPath(import.meta.url, './raw_ffi.child.ts');

/** Production factory: spawn a real isolated, lower-priority FFI decode child. */
export const defaultChildWorkerFactory: WorkerFactory = () =>
  new ChildProcessWorker(FFI_CHILD_SCRIPT, {
    nice: DEFAULT_NATIVE_CHILD_NICE,
    label: 'ffi-decode',
  }) as unknown as PoolWorker;

/** Re-exported so existing importers (and tests) keep a stable path. */
export { ChildProcessWorker };
