/**
 * Worker-side wiring for the FFI decode pool (ticket #673) and the decode
 * memory budget (#5467).
 *
 * The settings are saved by the API process; the decodes they govern run
 * here, in the worker. So the worker applies the persisted `performance` doc
 * at boot and then re-reads it on a short poll, which is how a change on
 * Settings → Workers reaches the live pool and budget without a restart.
 */

import { child as childLogger } from '../log.ts';
import { ffiPool } from './ffi-pool.ts';
import { readPerformanceConfig, resolveFfiPoolConfig } from './ffi-pool-config.repo.ts';
import { budgetBytesForPercent, decodeMemoryBudget } from './decode-memory-budget.ts';
import { readContainerMemory } from './container-memory.ts';

const log = childLogger('ffi:pool-bootstrap');
const REFRESH_MS = 5_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let appliedFingerprint: string | null = null;

/** Apply the persisted pool size and memory budget when either changed. A DB
 * failure throws and leaves the last applied values in force. */
export async function applyPerformanceConfig(): Promise<void> {
  const resolved = resolveFfiPoolConfig(await readPerformanceConfig());
  const container = readContainerMemory();
  const budgetBytes = budgetBytesForPercent(
    resolved.decode_memory_budget_percent,
    container.limitBytes,
  );
  const fingerprint = JSON.stringify([resolved, budgetBytes]);
  if (fingerprint === appliedFingerprint) return;
  ffiPool().setPoolSize(resolved.ffi_workers);
  decodeMemoryBudget().configure(budgetBytes);
  appliedFingerprint = fingerprint;
  log.info(
    {
      ffi_workers: resolved.ffi_workers,
      decode_memory_budget_percent: resolved.decode_memory_budget_percent,
      decode_memory_budget_bytes: budgetBytes,
      container_limit_bytes: container.limitBytes,
      container_limit_source: container.source,
      source: resolved.source,
    },
    'FFI decode pool and memory budget applied',
  );
}

/** Non-fatal: on failure the pool keeps its last applied (or default) size
 * and budget, and the next poll tries again. */
export async function bootstrapFfiPool(): Promise<void> {
  try {
    await applyPerformanceConfig();
  } catch (err) {
    log.warn({ err }, 'FFI pool configuration failed; the periodic refresh retries');
  }
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    applyPerformanceConfig().catch((err) =>
      log.warn({ err }, 'FFI pool configuration refresh failed'),
    );
  }, REFRESH_MS);
  refreshTimer.unref();
}

export function stopFfiPoolConfigRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  appliedFingerprint = null;
}
