/**
 * `GET/PATCH /api/workers/performance` bodies: the RAW decode-pool size
 * (#673) and the decode memory budget (#5467).
 *
 * Both settings are applied by the worker process, which re-reads the saved
 * doc every few seconds (`ffi/ffi-pool-bootstrap.ts`). The live reservation is
 * the worker's, persisted with its per-minute memory sample, so the readout is
 * at most a minute old and carries the sample time.
 */

import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  MAX_DECODE_MEMORY_BUDGET_PERCENT,
  MAX_FFI_WORKERS,
  MIN_DECODE_MEMORY_BUDGET_PERCENT,
  MIN_FFI_WORKERS,
  clampDecodeMemoryBudgetPercent,
  clampFfiWorkers,
  loadPerformanceConfig,
  resolveFfiPoolConfig,
  savePerformanceConfig,
  type PerformanceConfig,
} from '../ffi/ffi-pool-config.repo.ts';
import { readContainerMemory } from '../ffi/container-memory.ts';
import { budgetBytesForPercent } from '../ffi/decode-memory-budget.ts';
import { readWorkerStatus } from '../db/repos/worker-status.repo.ts';

export interface PerformancePatchBody {
  ffi_workers?: number;
  decode_memory_budget_percent?: number;
}

export async function performanceStatus() {
  const resolved = resolveFfiPoolConfig(await loadPerformanceConfig());
  const container = readContainerMemory();
  const workerMemory = (await readWorkerStatus())?.memory ?? null;
  const live = workerMemory?.decodeBudget ?? null;
  return {
    ffi_workers: resolved.ffi_workers,
    source: resolved.source.ffi_workers,
    min: MIN_FFI_WORKERS,
    max: MAX_FFI_WORKERS,
    pool: ffiPool().stats(),
    decode_memory_budget: {
      percent: resolved.decode_memory_budget_percent,
      source: resolved.source.decode_memory_budget_percent,
      min: MIN_DECODE_MEMORY_BUDGET_PERCENT,
      max: MAX_DECODE_MEMORY_BUDGET_PERCENT,
      budget_bytes: budgetBytesForPercent(
        resolved.decode_memory_budget_percent,
        container.limitBytes,
      ),
      container_limit_bytes: container.limitBytes,
      container_current_bytes: container.currentBytes,
      container_source: container.source,
      live: live && {
        limit_bytes: live.limitBytes,
        reserved_bytes: live.reservedBytes,
        running: live.running,
        waiting: live.waiting,
        at: workerMemory?.rows[0]?.at ?? null,
      },
    },
  };
}

type PatchOutcome = { ok: true } | { ok: false; status: 400 | 500; error: string };

function invalid(field: string, value: unknown): PatchOutcome {
  return {
    ok: false,
    status: 400,
    error: `Invalid ${field}: must be a finite number (got ${value})`,
  };
}

/** Clamp and persist whichever fields were sent; the API's own pool resizes now. */
export async function patchPerformance(body: PerformancePatchBody): Promise<PatchOutcome> {
  if (body.ffi_workers === undefined && body.decode_memory_budget_percent === undefined) {
    return {
      ok: false,
      status: 400,
      error: 'Nothing to update: send ffi_workers and/or decode_memory_budget_percent',
    };
  }
  const workers = body.ffi_workers === undefined ? undefined : clampFfiWorkers(body.ffi_workers);
  if (workers === null) return invalid('ffi_workers', body.ffi_workers);
  const percent =
    body.decode_memory_budget_percent === undefined
      ? undefined
      : clampDecodeMemoryBudgetPercent(body.decode_memory_budget_percent);
  if (percent === null) {
    return invalid('decode_memory_budget_percent', body.decode_memory_budget_percent);
  }
  const patch: Partial<PerformanceConfig> = {
    ...(workers === undefined ? {} : { ffi_workers: workers }),
    ...(percent === undefined ? {} : { decode_memory_budget_percent: percent }),
  };
  try {
    await savePerformanceConfig(patch);
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
  ffiPool().setPoolSize(resolveFfiPoolConfig(await loadPerformanceConfig()).ffi_workers);
  return { ok: true };
}
