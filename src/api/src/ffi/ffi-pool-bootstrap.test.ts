import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
import {
  applyPerformanceConfig,
  applyRequestProcessConfig,
  stopFfiPoolConfigRefresh,
} from './ffi-pool-bootstrap.ts';
import * as configRepo from './ffi-pool-config.repo.ts';
import { savePerformanceConfig } from './ffi-pool-config.repo.ts';
import {
  budgetBytesForPercent,
  decodeMemoryBudget,
  REQUEST_PROCESS_BUDGET_SHARE,
  WORKER_TIER_BUDGET_SHARE,
} from './decode-memory-budget.ts';
import { readContainerMemory } from './container-memory.ts';
import { _resetFfiPoolForTests, ffiPool } from './ffi-pool.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  stopFfiPoolConfigRefresh();
  decodeMemoryBudget().configure(null);
  _resetFfiPoolForTests();
});

describe('applyPerformanceConfig (worker side, #5467)', () => {
  it('caps decodes at the worker share of the default percentage on a fresh install', async () => {
    using _live = await createLiveTestDatabase();
    await applyPerformanceConfig();
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      budgetBytesForPercent(50, readContainerMemory().limitBytes, WORKER_TIER_BUDGET_SHARE),
    );
  });

  it('applies a saved percent and pool size, and lifts the cap at 0', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 6, decode_memory_budget_percent: 25 });
    await applyPerformanceConfig();
    expect(ffiPool().poolSize()).toBe(6);
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      budgetBytesForPercent(25, readContainerMemory().limitBytes, WORKER_TIER_BUDGET_SHARE),
    );

    await savePerformanceConfig({ decode_memory_budget_percent: 0 });
    await applyPerformanceConfig();
    expect(decodeMemoryBudget().capped()).toBe(false);
  });
});

describe('applyRequestProcessConfig (request-serving process, #6101)', () => {
  it('applies the saved worker count and its share of the budget, and lets an oversize decode run alone', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 16, decode_memory_budget_percent: 40 });
    await applyRequestProcessConfig();
    const limit = budgetBytesForPercent(
      40,
      readContainerMemory().limitBytes,
      REQUEST_PROCESS_BUDGET_SHARE,
    )!;
    expect(ffiPool().poolSize()).toBe(16);
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(limit);

    const oversize = await decodeMemoryBudget().acquire(limit + 1);
    expect(decodeMemoryBudget().snapshot().running).toBe(1);
    oversize();
  });

  it('follows a later save and lifts the cap at 0', async () => {
    using _live = await createLiveTestDatabase();
    await applyRequestProcessConfig();
    await savePerformanceConfig({ ffi_workers: 3, decode_memory_budget_percent: 0 });
    await applyRequestProcessConfig();
    expect(ffiPool().poolSize()).toBe(3);
    expect(decodeMemoryBudget().capped()).toBe(false);
  });

  it('meters at the default share while the saved setting cannot be read, then applies it on the retry', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 5, decode_memory_budget_percent: 30 });
    jest.useFakeTimers();
    const read = spyOn(configRepo, 'readPerformanceConfig').mockRejectedValueOnce(
      new Error('busy'),
    );

    await applyRequestProcessConfig();
    const container = readContainerMemory().limitBytes;
    expect(ffiPool().poolSize()).toBe(1);
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      budgetBytesForPercent(50, container, REQUEST_PROCESS_BUDGET_SHARE),
    );

    jest.advanceTimersByTime(5_000);
    jest.useRealTimers();
    await Bun.sleep(100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(ffiPool().poolSize()).toBe(5);
    expect(decodeMemoryBudget().snapshot().limitBytes).toBe(
      budgetBytesForPercent(30, container, REQUEST_PROCESS_BUDGET_SHARE),
    );
  });

  it('keeps a later save when an earlier, slower read finishes after it', async () => {
    using _live = await createLiveTestDatabase();
    await savePerformanceConfig({ ffi_workers: 7 });
    const stale = Promise.withResolvers<configRepo.PerformanceConfig | null>();
    spyOn(configRepo, 'readPerformanceConfig').mockImplementationOnce(() => stale.promise);
    const earlier = applyPerformanceConfig('request');
    jest.restoreAllMocks();
    await applyPerformanceConfig('request');
    expect(ffiPool().poolSize()).toBe(7);

    stale.resolve({ ffi_workers: 2, updated_at: 1 } as configRepo.PerformanceConfig);
    await earlier;
    expect(ffiPool().poolSize()).toBe(7);
  });
});
