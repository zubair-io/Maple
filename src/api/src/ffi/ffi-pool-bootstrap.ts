/**
 * Boot-time wiring for the FFI decode pool (ticket #673).
 *
 * Resolves the operator-configured pool size (DB > env `MAPLE_FFI_WORKERS` >
 * default 1) and applies it to the process-wide `ffiPool()`. Kept separate
 * from `ffi-pool-config.repo.ts` (pure config, no pool dependency) and from
 * `index.ts` (keeps the boot sequence thin + under the file-size budget).
 */

import { child as childLogger } from '../log.ts';
import { ffiPool } from './ffi-pool.ts';
import { loadPerformanceConfig, resolveFfiPoolConfig } from './ffi-pool-config.repo.ts';

const log = childLogger('ffi:pool-bootstrap');

/**
 * Size the live FFI decode pool from the persisted/env config. Default 1
 * keeps the historical single-decode behaviour; a saved value raises the
 * lazy spawn ceiling so RAW thumb/preview decodes run in parallel across
 * cores. Non-fatal: on failure the pool stays at its default and the operator
 * can resize live via `PATCH /api/workers/performance`.
 */
export async function bootstrapFfiPool(): Promise<void> {
  try {
    const resolved = resolveFfiPoolConfig(await loadPerformanceConfig());
    ffiPool().setPoolSize(resolved.ffi_workers);
    log.info(
      { ffi_workers: resolved.ffi_workers, source: resolved.source.ffi_workers },
      'FFI decode pool sized',
    );
  } catch (err) {
    log.warn({ err }, 'FFI pool sizing failed; staying at default');
  }
}
