/**
 * Wiring for the FFI decode pool (ticket #673) and the decode memory budget
 * (#5467), in both processes that own a pool.
 *
 * The worker tier applies the persisted `performance` doc at boot and then
 * re-reads it on a short poll, which is how a change on Settings → Workers
 * reaches its live pool and budget without a restart. The request-serving
 * process, which renders on demand, applies the same doc at boot and again
 * whenever its own settings route saves one (#6101). The configured memory
 * percentage is split between the two (`REQUEST_PROCESS_BUDGET_SHARE`).
 */

import { child as childLogger } from '../log.ts';
import { ffiPool } from './ffi-pool.ts';
import {
  DEFAULT_DECODE_MEMORY_BUDGET_PERCENT,
  readPerformanceConfig,
  resolveFfiPoolConfig,
} from './ffi-pool-config.repo.ts';
import {
  REQUEST_PROCESS_BUDGET_SHARE,
  WORKER_TIER_BUDGET_SHARE,
  budgetBytesForPercent,
  decodeMemoryBudget,
} from './decode-memory-budget.ts';
import { readContainerMemory } from './container-memory.ts';

const log = childLogger('ffi:pool-bootstrap');
const REFRESH_MS = 5_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let appliedFingerprint: string | null = null;
let latestApplyStarted = 0;

export type PoolOwner = 'worker' | 'request';

const budgetShare = (owner: PoolOwner): number =>
  owner === 'worker' ? WORKER_TIER_BUDGET_SHARE : REQUEST_PROCESS_BUDGET_SHARE;

function budgetFor(owner: PoolOwner, percent: number, containerLimitBytes: number) {
  return budgetBytesForPercent(percent, containerLimitBytes, budgetShare(owner));
}

function configureBudget(owner: PoolOwner, budgetBytes: number | null): void {
  decodeMemoryBudget().configure(budgetBytes, { oversizeRunsAlone: owner === 'request' });
}

/** Apply the persisted pool size and memory budget when either changed. A DB
 * failure throws and leaves the last applied values in force. */
export async function applyPerformanceConfig(owner: PoolOwner = 'worker'): Promise<void> {
  const generation = ++latestApplyStarted;
  const resolved = resolveFfiPoolConfig(await readPerformanceConfig());
  // A read that began earlier than another apply may hold older values; the later apply wins.
  if (generation !== latestApplyStarted) return;
  const container = readContainerMemory();
  const budgetBytes = budgetFor(owner, resolved.decode_memory_budget_percent, container.limitBytes);
  const fingerprint = JSON.stringify([owner, resolved, budgetBytes]);
  if (fingerprint === appliedFingerprint) return;
  ffiPool().setPoolSize(resolved.ffi_workers);
  configureBudget(owner, budgetBytes);
  appliedFingerprint = fingerprint;
  log.info(
    {
      owner,
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

/** Non-fatal: if the DB is unreachable the pool keeps its size and the budget
 * takes the default percentage, so decodes are never left unmetered. */
async function applyOrFallBack(owner: PoolOwner): Promise<void> {
  try {
    await applyPerformanceConfig(owner);
  } catch (err) {
    configureBudget(
      owner,
      budgetFor(owner, DEFAULT_DECODE_MEMORY_BUDGET_PERCENT, readContainerMemory().limitBytes),
    );
    log.warn({ err, owner }, 'FFI pool configuration failed; default budget applied');
  }
}

let requestRetryTimer: ReturnType<typeof setInterval> | null = null;

/** Request-serving process, at boot before it listens: a failed read applies the default budget and
 * keeps retrying, so a transient failure never leaves the pool at one child for good. */
export async function applyRequestProcessConfig(): Promise<void> {
  await applyOrFallBack('request');
  if (requestRetryTimer || appliedFingerprint !== null) return;
  requestRetryTimer = setInterval(() => {
    applyPerformanceConfig('request')
      .then(() => {
        if (appliedFingerprint !== null) stopRequestRetry();
      })
      .catch((err) => log.warn({ err }, 'FFI pool configuration retry failed'));
  }, REFRESH_MS);
  requestRetryTimer.unref();
}

function stopRequestRetry(): void {
  if (requestRetryTimer) clearInterval(requestRetryTimer);
  requestRetryTimer = null;
}

/** Worker tier: at boot, then on a poll that retries a failed read. */
export async function bootstrapFfiPool(): Promise<void> {
  await applyOrFallBack('worker');
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
  stopRequestRetry();
  appliedFingerprint = null;
}
